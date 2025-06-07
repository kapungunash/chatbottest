// index.js

require('dotenv').config();
const express    = require('express');
const bodyParser = require('body-parser');
const axios      = require('axios');
const qs         = require('querystring');
const mysql      = require('mysql2/promise');
const nodemailer = require('nodemailer');

// ─── In‐Memory State ──────────────────────────────────────────────────────────
const userStates = {};

// ─── Environment Variables ───────────────────────────────────────────────────
const PORT             = process.env.PORT || 3000;
const TOKEN            = process.env.TOKEN;            // WhatsApp Cloud API token
const PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID;  // Phone Number ID from Meta
const VERIFY_TOKEN     = process.env.VERIFY_TOKEN;     // Your webhook verify token

if (!TOKEN || !PHONE_NUMBER_ID || !VERIFY_TOKEN) {
  console.error('❌ Missing environment variables. Please set TOKEN, PHONE_NUMBER_ID, and VERIFY_TOKEN in .env');
  process.exit(1);
}

// Base URL for sending messages via the WhatsApp Business Cloud API
const WH_API_BASE = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;

// ─── MySQL Pool Configuration ────────────────────────────────────────────────
// Using your hosting server’s credentials and remote host
const pool = mysql.createPool({
  host: '173.249.32.141',   // Public hostname for MySQL
  port: 3306,                   // MariaDB default port
  user: 'portaladmin',
  password: 'panashe@03',
  database: 'PortalRuwa',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// ─── Nodemailer (Email) Configuration ────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host: 'smtp.ruwalocalboard.co.zw',
  port: 465,
  secure: true,
  auth: {
    user: 'pkapungu@ruwalocalboard.co.zw',
    pass: 'Panashegift'
  },
  tls: {
    rejectUnauthorized: false
  }
});

// Email helper
async function sendEmail(to, subject, html) {
  return mailer.sendMail({
    from: '"Ruwa Local Board" <pkapungu@ruwalocalboard.co.zw>',
    to,
    subject,
    html
  });
}

// ─── Constants for Billing Flow ──────────────────────────────────────────────
const PORTAL_LOGIN_URL       = 'https://portal.ruwalocalboard.co.zw/data/login2.php';
const PORTAL_API_URL         = 'https://portal.ruwalocalboard.co.zw/api.php';
const PDF_STATEMENT_URL_BASE = 'https://portal.ruwalocalboard.co.zw/stat/statement.php?id=';

// ─── Express Setup ───────────────────────────────────────────────────────────
const app = express();
app.use(bodyParser.json());

// Optional: a simple home route so "/" doesn’t 404
app.get('/', (req, res) => {
  res.send('🤖 WhatsApp bot is running. Webhook endpoint is /webhook');
});

// ─── 1) Webhook Verification (GET) ───────────────────────────────────────────
// This endpoint is used by Facebook/Meta to verify your webhook.
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ WEBHOOK_VERIFIED');
    return res.status(200).send(challenge);
  } else {
    console.error('❌ WEBHOOK_VERIFICATION_FAILED');
    return res.sendStatus(403);
  }
});

// ─── 2) Webhook Event Receiver (POST) ─────────────────────────────────────────
// All incoming messages will be sent here by Meta’s servers.
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Check that this is a WhatsApp message event
    if (
      body.object &&
      body.entry &&
      Array.isArray(body.entry) &&
      body.entry[0].changes &&
      Array.isArray(body.entry[0].changes)
    ) {
      for (const entry of body.entry) {
        for (const change of entry.changes) {
          if (
            change.value &&
            change.value.messages &&
            Array.isArray(change.value.messages)
          ) {
            for (const message of change.value.messages) {
              const from        = message.from;       
              const messageType = message.type;     

              // 1) Plain‐text flows
              if (messageType === 'text') {
                const msgBody = message.text.body;
                console.log(`📩 Received text from ${from}:`, msgBody);
                await handleIncomingText(from, msgBody.trim().toLowerCase());
                continue;
              }

              // 2) Interactive replies (list or button)
              if (messageType === 'interactive') {
                const interactive = message.interactive;
                let replyId = null;

                if (interactive.list_reply) {
                  replyId = interactive.list_reply.id;
                } else if (interactive.button_reply) {
                  replyId = interactive.button_reply.id;
                }

                console.log(`📩 Received interactive from ${from}:`, replyId);
                if (replyId) {
                  await handleInteractiveReply(from, replyId);
                } else {
                  await sendTextMessage(from, 'Sorry, I didn’t understand that selection. Type “menu” to start over.');
                }
                continue;
              }

              // 3) Unsupported types
              console.log(`📩 Received unsupported message type (${messageType}) from ${from}.`);
              await sendTextMessage(from, 'Sorry, I can only process text or menu selections right now.');
            }
          }
        }
      }

      return res.sendStatus(200);
    } else {
      // Not a message event; just return 200
      return res.sendStatus(200);
    }
  } catch (error) {
    console.error('❌ Error processing webhook POST:', error);
    return res.sendStatus(500);
  }
});

// ─── 3) Handle Incoming Text ─────────────────────────────────────────────────
async function handleIncomingText(from, text) {
  // text is already trimmed and lowercased

  // If user requests “menu” or “hello” or “hi”, send the main interactive list
  if (text === 'menu' || text === 'hello' || text === 'hi') {
    delete userStates[from];
    return sendMainMenu(from);
  }

  // If user says “1” or “customer relations”, start that flow
  if (text === '1' || text.includes('customer relations')) {
    userStates[from] = { submenu: 'customer_relations' };
    return sendCustomerRelationsMenu(from);
  }

  // If user says “2” or “billing”, start billing flow
  if (text === '2' || text.includes('billing')) {
    userStates[from] = { step: 1, process: 'billing_enquiry' };
    return sendTextMessage(from, 'Please enter your account number:');
  }

  // If user is already in a multi-step flow, forward to the appropriate handler
  if (userStates[from]?.step) {
    const { process } = userStates[from];
    switch (process) {
      case 'query':
        return handleQueryFlow(from, text);
      case 'complaint':
        return handleComplaintFlow(from, text);
      case 'suggestion':
        return handleSuggestionFlow(from, text);
      case 'billing_enquiry':
        return handleBillingFlow(from, text);
      default:
        return sendTextMessage(from, 'An error occurred. Type “menu” to start over.');
    }
  }

  // Fallback: user typed something not recognized
  return sendTextMessage(from, 'Sorry, I didn’t understand. Type “menu” to see options.');
}

// ─── 4) Handle Interactive Replies (List/Buttons) ────────────────────────────
async function handleInteractiveReply(from, replyId) {
  switch (replyId) {
    // ─── Main Menu Selections ───────────────────────────────────────────────
    case 'customer_relations':
      userStates[from] = { submenu: 'customer_relations' };
      return sendCustomerRelationsMenu(from);

    case 'billing':
      userStates[from] = { step: 1, process: 'billing_enquiry' };
      return sendTextMessage(from, 'Please enter your account number:');

    case 'service_requests':
      userStates[from] = { step: 1, process: 'service_requests' };
      return sendTextMessage(from, 'Please describe your service request:');

    case 'faqs':
      return sendTextMessage(from, 'You asked for FAQs. Visit: https://ruwalocalboard.co.zw/faqs');

    case 'live_agent':
      return sendTextMessage(from, 'Connecting you to a live agent…');

    // ─── Customer Relations Sub‐Menu ────────────────────────────────────────
    case 'log_query':
      userStates[from] = { step: 1, process: 'query' };
      return sendTextMessage(from, 'Step 1/5: Enter your full name:');

    case 'submit_complaint':
      userStates[from] = { step: 1, process: 'complaint' };
      return sendTextMessage(from, 'Step 1/3: Enter your full name:');

    case 'make_suggestion':
      userStates[from] = { step: 1, process: 'suggestion' };
      return sendTextMessage(from, 'Step 1/3: Enter your full name:');

    case 'back_main':
      delete userStates[from];
      return sendMainMenu(from);

    // ─── Confirmation Buttons ───────────────────────────────────────────────
    case 'confirm_yes':
      if (userStates[from]?.process === 'query') {
        return finalizeQuerySubmission(from);
      }
      if (userStates[from]?.process === 'complaint') {
        return sendTextMessage(from, '✅ Complaint confirmed and logged.');
      }
      if (userStates[from]?.process === 'suggestion') {
        return sendTextMessage(from, '✅ Suggestion confirmed and logged.');
      }
      return;

    case 'confirm_no':
      delete userStates[from];
      return sendTextMessage(from, 'Your submission was cancelled. Type “menu” to start over.');

    // ─── PDF Buttons in Billing Flow ───────────────────────────────────────
    case 'pdf_yes':
      {
        const state = userStates[from];
        const pdfUrl = `${PDF_STATEMENT_URL_BASE}${state.account}`;
        return sendTextMessage(from, `Here is your PDF statement:\n${pdfUrl}`);
      }

    case 'pdf_no':
      delete userStates[from];
      return sendTextMessage(from, 'Okay! If you need anything else, type “menu.”');

    // ─── Category Selection from sendCategoryList ──────────────────────────
    default: {
      const num = parseInt(replyId, 10);
      if (!isNaN(num) && num >= 1 && num <= 15 && userStates[from]?.step === 4) {
        userStates[from].category = num;
        userStates[from].step = 5;
        return sendTextMessage(from, 'Step 5/5: Enter your query description:');
      }
      return sendTextMessage(from, 'Sorry, I didn’t understand that choice. Type “menu” to start over.');
    }

      case 'more':
        if (userStates[from]?.step === 4) {
          return sendMoreCategories(from);
        } else {
          return sendTextMessage(from, 'Please follow the menu. Type “menu” to start over.');
        }
        


  }
}

// ─── 5) Send a Simple Text Message ──────────────────────────────────────────
async function sendTextMessage(to, body) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    text: { body }
  };

  try {
    await axios.post(WH_API_BASE, payload, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`✅ Sent text to ${to}: "${body}"`);
  } catch (err) {
    console.error('❌ Error sending text message:', err.response?.data || err.message);
  }
}

// ─── 6) Send the Main Interactive List ──────────────────────────────────────
async function sendMainMenu(to) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Ruwa Local Board Services' },
      body: {
        text: 'Hi there! 👋 I’m Ruvimbo, your virtual assistant at Ruwa Local Board. Need help with bills, services, or local info? I’ve got you covered!'
      },
      
      footer: { text: '' },
      action: {
        button: 'Choose an option',
        sections: [
          {
            title: 'Core Services',
            rows: [
              { id: 'customer_relations', title: 'Customer Relations', description: 'Queries/Complaints/Suggestions' },
              { id: 'billing',            title: 'Bill Enquiries',       description: 'Account balance & statements' },
              { id: 'service_requests',   title: 'Service Requests',     description: 'Report issues' }
            ]
          },
          {
            title: 'Support',
            rows: [
              { id: 'faqs',       title: 'FAQs',       description: 'Common questions' },
              { id: 'live_agent', title: 'Live Agent', description: 'Speak to human' }
            ]
          }
        ]
      }
    }
  };

  try {
    await axios.post(WH_API_BASE, payload, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`✅ Sent main menu to ${to}`);
  } catch (err) {
    console.error('❌ Error sending main menu:', err.response?.data || err.message);
  }
}

// ─── 7) Send Customer Relations Sub‐Menu ────────────────────────────────────
async function sendCustomerRelationsMenu(to) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Customer Relations' },
      body:   { text: 'Select an option:' },
      footer: { text: '' },
      action: {
        button: 'Choose service',
        sections: [
          {
            title: 'Services',
            rows: [
              { id: 'log_query',        title: 'Log Query' },
              { id: 'submit_complaint', title: 'Submit Complaint' },
              { id: 'make_suggestion',  title: 'Make Suggestion' }
            ]
          },
          {
            title: 'Navigation',
            rows: [
              { id: 'back_main', title: 'Back to Main Menu' }
            ]
          }
        ]
      }
    }
  };

  try {
    await axios.post(WH_API_BASE, payload, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`✅ Sent Customer Relations menu to ${to}`);
  } catch (err) {
    console.error('❌ Error sending customer menu:', err.response?.data || err.message);
  }
}

// ─── 8) Send Category List for Queries ──────────────────────────────────────
async function sendCategoryList(to) {
  // Build rows for categories 1–9
  const rows = [];
  for (let i = 1; i <= 9; i++) {
    const title = truncate24(getCategoryName(i));
    rows.push({ id: String(i), title });
  }

  // Add a “More categories” row
  rows.push({ id: 'more', title: '➕ More categories' });

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Choose a Category (1–9)' },
      body:   { text: 'Step 4/5: Select one category or tap “More categories”.' },
      footer: { text: '' },
      action: {
        button: 'Select Category',
        sections: [
          {
            title: 'Categories (1–9)',
            rows // exactly 10 rows: nine categories + “More categories”
          }
        ]
      }
    }
  };

  try {
    await axios.post(WH_API_BASE, payload, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`✅ Sent first-phase category list to ${to}`);
  } catch (err) {
    console.error('❌ Error sending first-phase category list:', err.response?.data || err.message);
  }
}

async function sendMoreCategories(to) {
  const rows = [];
  for (let i = 10; i <= 15; i++) {
    const title = truncate24(getCategoryName(i));
    rows.push({ id: String(i), title });
  }

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'More Categories (10–15)' },
      body:   { text: 'Step 4/5: Select one category from 10–15.' },
      footer: { text: '' },
      action: {
        button: 'Select Category',
        sections: [
          {
            title: 'Categories (10–15)',
            rows // exactly 6 rows
          }
        ]
      }
    }
  };

  try {
    await axios.post(WH_API_BASE, payload, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`✅ Sent second-phase category list to ${to}`);
  } catch (err) {
    console.error('❌ Error sending second-phase category list:', err.response?.data || err.message);
  }
}
// ─── 9) Query Flow (5 steps + confirmation) ─────────────────────────────────
async function handleQueryFlow(from, text) {
  const state = userStates[from];

  switch (state.step) {
    case 1:
      state.fullName = text;
      state.step = 2;
      return sendTextMessage(from, 'Step 2/5: Enter your address:');

    case 2:
      state.address = text;
      state.step = 3;
      return sendTextMessage(from, 'Step 3/5: Enter your email address:');

    case 3:
      state.email = text;
      state.step = 4;
      return sendCategoryList(from);

    case 4:
      // Handled via interactive list in handleInteractiveReply
      return sendTextMessage(from, 'Please select a category from the list.');

    case 5:
      state.query = text;
      // Show summary and send confirm buttons
      await sendTextMessage(
        from,
        `Name: ${state.fullName}\n` +
        `Address: ${state.address}\n` +
        `Email: ${state.email}\n` +
        `Category: ${getCategoryName(state.category)}\n` +
        `Query: ${state.query}`
      );
      return sendConfirmationButtons(from);

    case 6:
      return sendTextMessage(from, 'Please tap ✅ Yes or ❌ No to confirm or cancel.');

    default:
      return sendTextMessage(from, 'An error occurred. Type “cancel” to restart.');
  }
}

async function sendConfirmationButtons(to) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Confirm submission?' },
      footer: { text: '' },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: { id: 'confirm_yes', title: '✅ Yes' }
          },
          {
            type: 'reply',
            reply: { id: 'confirm_no',  title: '❌ No'  }
          }
        ]
      }
    }
  };

  try {
    await axios.post(WH_API_BASE, payload, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`✅ Sent confirmation buttons to ${to}`);
    userStates[to].step = 6;
  } catch (err) {
    console.error('❌ Error sending confirmation buttons:', err.response?.data || err.message);
  }
}

// ─── 10) finalizeQuerySubmission with DB insertion ───────────────────────────
async function finalizeQuerySubmission(from) {
  const state   = userStates[from];
  const queryId = generateQueryId();

  // Build the JSON payload exactly as db-api.php expects
  const payload = {
    full_name:   state.fullName,       // e.g. "John Smith"
    address:     state.address,        // e.g. "45 Elm Ave"
    email:       state.email,          // e.g. "john@example.com"
    category_id: state.category,       // e.g. 3
    description: state.query,          // e.g. "I need a development permit."
    query_id:    queryId,               // e.g."QR12345W"
    client_whatsapp: from  
  };

  try {
    // Replace yourdomain.com with your actual domain
    const apiRes = await axios.post(
      'https://portal.ruwalocalboard.co.zw./db-api.php',
      payload,
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );

    const data = apiRes.data;
    if (!data.success) {
      console.error('PHP API returned error:', data);
      await sendTextMessage(from, '⚠️ Could not log your query. Please try again later.');
      delete userStates[from];
      return;
    }

    // If assigned === true, send email & reply accordingly
    if (data.assigned) {
      const staffName  = data.assigned_name;   // string
      const staffEmail = data.assigned_email; 
      const staffNumber = data.assigned_number; // string

      // 1) Send email to staff
      const htmlBody = `
      <p>Hello ${staffName},</p>
      <p>A new query (<strong>${queryId}</strong>) has been assigned to you:</p>
      <ul>
        <li>Category: ${getCategoryName(state.category)}</li>
        <li>From: ${state.fullName} (${state.email})</li>
        <li><strong>Client WhatsApp:</strong> ${from}</li>
        <li>Address: ${state.address}</li>
        <li>Query: ${state.query}</li>
      </ul>
      <p>Please log in to the portal to update its status.</p>
      <p>Thank you.</p>
    `;
      await sendEmail(staffEmail, `New Query Assigned: ${queryId}`, htmlBody);

      // 2) Reply to the user on WhatsApp
      await sendTextMessage(
        from,
        `✅ Query Successfully Logged\nYour Query ID is *${queryId}*.\n\n` +
        `It has been assigned to *${staffName}*. They will reach out soon.`
      );

      await sendTextMessage(
        staffNumber,
        `📬 New query *${queryId}* assigned to you:\n` +
        `• Category: ${getCategoryName(state.category)}\n` +
        `• From: ${state.fullName} (${state.email})\n` +
        `• Client WhatsApp: ${from}\n` +
        `• Address: ${state.address}\n` +
        `• Query: ${state.query}\n\n` +
        `Please log in to the portal to update its status.`
      );




    } else {
      // No staff was assigned
      await sendTextMessage(
        from,
        `✅ Query Logged with ID *${queryId}*.\n` +
        `Currently no staff is assigned to this category. We will update you when someone is assigned.`
      );
    }
  } catch (err) {
    console.error('Error calling PHP API:', err.response?.data || err.message);
    await sendTextMessage(from, '⚠️ System error. Please try again later.');
  }

  delete userStates[from];
}
// ─── 11) Complaint Flow (3 steps) ───────────────────────────────────────────
async function handleComplaintFlow(from, text) {
  const state = userStates[from];

  switch (state.step) {
    case 1:
      state.fullName = text;
      state.step = 2;
      return sendTextMessage(from, 'Step 2/3: Describe your complaint in detail:');

    case 2:
      state.complaint = text;
      state.step = 3;
      return sendTextMessage(
        from,
        `Confirm your complaint:\nName: ${state.fullName}\nComplaint: ${state.complaint}\n\n` +
        'Reply *yes* to confirm or *cancel* to abort.'
      );

    case 3:
      if (text.toLowerCase() === 'yes') {
        await sendTextMessage(from, '✅ Complaint logged successfully! We will get back to you shortly.');
        logComplaint(state);
      } else {
        await sendTextMessage(from, 'ℹ️ Process cancelled. Enjoy your day!');
      }
      delete userStates[from];
      return;

    default:
      return sendTextMessage(from, 'An error occurred. Type *cancel* to restart.');
  }
}

// ─── 12) Suggestion Flow (3 steps) ─────────────────────────────────────────
async function handleSuggestionFlow(from, text) {
  const state = userStates[from];

  switch (state.step) {
    case 1:
      state.fullName = text;
      state.step = 2;
      return sendTextMessage(from, 'Step 2/3: Describe your suggestion:');

    case 2:
      state.suggestion = text;
      state.step = 3;
      return sendTextMessage(
        from,
        `Confirm your suggestion:\nName: ${state.fullName}\nSuggestion: ${state.suggestion}\n\n` +
        'Reply *yes* to confirm or *cancel* to abort.'
      );

    case 3:
      if (text.toLowerCase() === 'yes') {
        await sendTextMessage(from, '✅ Suggestion logged successfully! Thank you for your feedback.');
        logSuggestion(state);
      } else {
        await sendTextMessage(from, 'ℹ️ Process cancelled. Enjoy your day!');
      }
      delete userStates[from];
      return;

    default:
      return sendTextMessage(from, 'An error occurred. Type *cancel* to restart.');
  }
}

// ─── 13) Billing Flow (3 steps + PDF) ──────────────────────────────────────
async function handleBillingFlow(from, text) {
  const state = userStates[from];

  switch (state.step) {
    case 1:
      state.account = text.trim();
      state.step = 2;
      return sendTextMessage(from, 'Please enter your portal password:');

    case 2:
      state.password = text.trim();
      state.step = 3;
      await sendTextMessage(from, 'Fetching your bill details…');

      try {
        // 1) Login to portal
        const loginRes = await axios.post(
          PORTAL_LOGIN_URL,
          qs.stringify({ username: state.account, password: state.password }),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'Mozilla/5.0'
            },
            withCredentials: true,
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 400
          }
        );

        if (!loginRes.data?.success) {
          const errMsg = loginRes.data?.error || 'Invalid username or password.';
          await sendTextMessage(from, `❌ Login failed: ${errMsg}`);
          delete userStates[from];
          return;
        }

        // Extract session cookies
        const cookies = loginRes.headers['set-cookie'];
        if (!Array.isArray(cookies) || !cookies.length) {
          await sendTextMessage(from, '❌ Login succeeded but no session cookie was returned.');
          delete userStates[from];
          return;
        }
        state.cookieString = cookies.map(c => c.split(';')[0]).join('; ');

        // 2) Fetch bill data from API
        const billRes = await axios.get(PORTAL_API_URL, {
          headers: { Cookie: state.cookieString, 'User-Agent': 'Mozilla/5.0' },
          withCredentials: true,
          validateStatus: status => status >= 200 && status < 400
        });

        const bill = billRes.data;
        if (!bill?.account) {
          await sendTextMessage(from, '❌ Could not parse bill data: ' + JSON.stringify(bill, null, 2));
          delete userStates[from];
          return;
        }

        // 3) Build text reply
        let replyText = `🏦 *BILL STATEMENT* 🏦\n\n` +
                        `Account: ${bill.account.number}\n` +
                        `Name: ${bill.account.name}\n` +
                        `Balance: USD ${bill.account.balance}\n\n`;

        if (bill.account.last_payment && bill.account.last_payment_date) {
          replyText += `Last Payment: USD ${bill.account.last_payment} (${bill.account.last_payment_date})\n\n`;
        }

        if (Array.isArray(bill.transactions) && bill.transactions.length) {
          replyText += `*RECENT TRANSACTIONS*\n`;
          bill.transactions.slice(0, 5).forEach((tran, i) => {
            replyText += `${i + 1}. ${tran['tr-date']} – ${tran.detail}: USD ${tran.amount}\n`;
          });
          replyText += `\n`;
        } else {
          replyText += `No recent transactions found.\n\n`;
        }

        replyText += `💳 *PAYMENT METHODS* 💳\n` +
                     `1. Online: https://www.topup.co.zw/pay-bill/ruwa-local-board\n` +
                     `2. Bank Transfer:\n   ZB BANK\n   4136-00060989-207 ZWG\n   4136-00060989-405 USD\n` +
                     `3. Mobile Ecocash: *151*2*1*87208*Amount*StandNo#\n\n` +
                     `Need help? Call: 0242 132 988\n\n` +
                     `To get a PDF statement, reply “PDF”.\n`;

        await sendTextMessage(from, replyText);

        // 4) Prompt for PDF or menu
        state.step = 4;
        return sendTextMessage(from, 'Type “PDF” to receive your PDF statement, or type “menu” to go back.');

      } catch (err) {
        console.error('❌ Billing error:', err);
        await sendTextMessage(from, '⚠️ Error fetching bill details. Please try again later.');
        delete userStates[from];
      }
      return;

    case 4:
      const lower = text.trim().toLowerCase();
      if (lower === 'pdf') {
        const pdfUrl = `${PDF_STATEMENT_URL_BASE}${state.account}`;
        return sendTextMessage(from, `Here is your PDF statement:\n${pdfUrl}`);
      } else if (lower === 'menu') {
        delete userStates[from];
        return sendMainMenu(from);
      } else {
        return sendTextMessage(from, 'Please type “PDF” to receive the statement, or “menu” to go back.');
      }

    default:
      return sendTextMessage(from, 'An error occurred. Type “cancel” to restart.');
  }
}

// ─── Utility Functions ─────────────────────────────────────────────────────
function generateQueryId() {
  const prefix = 'QR';
  const randomNumber = Math.floor(Math.random() * 100000);
  return `${prefix}${randomNumber}W`;
}

function getCategoryName(num) {
  const categories = [
    'Grave (Cemetery)',
    'Water Services',
    'Development Permit Processing',
    'Rates Clearance',
    'Payment of Supplier Creditors',
    'Debt Collection',
    'Health Services at Clinics',
    'Lease Extension Agreements',
    'Tariffs',
    'Meter Reading',
    'Sewer Services',
    'Building Inspectorate',
    'Roads Management',
    'Public Relations Services',
    'Transport Management'
  ];
  return categories[num - 1] || 'Unknown';
}

// ─── Utility: Truncate a string to 24 chars ─────────────────────────────────
function truncate24(str) {
  return str.length > 24 ? str.slice(0, 24) : str;
}

function logComplaint(complaint) {
  console.log('Complaint Logged:', complaint);
}

function logSuggestion(suggestion) {
  console.log('Suggestion Logged:', suggestion);
}

// ─── Start Express Server & Graceful Shutdown ──────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server is listening on http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  console.log('🛑 Shutting down gracefully…');
  process.exit(0);
});
