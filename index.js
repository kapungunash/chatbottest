// index.js

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

// ─── Environment Variables ─────────────────────────────────────────────────
const PORT             = process.env.PORT || 3000;
const TOKEN            = process.env.TOKEN;            // Your Business API access token
const PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID;  // Your Phone Number ID from Meta
const VERIFY_TOKEN     = process.env.VERIFY_TOKEN;     // Your webhook verify token

if (!TOKEN || !PHONE_NUMBER_ID || !VERIFY_TOKEN) {
  console.error('❌ Missing environment variables. Please set TOKEN, PHONE_NUMBER_ID, and VERIFY_TOKEN in .env');
  process.exit(1);
}

// Base URL for sending messages via the WhatsApp Business Cloud API
const WH_API_BASE = `https://graph.facebook.com/v15.0/${PHONE_NUMBER_ID}/messages`;

// ─── Express Setup ───────────────────────────────────────────────────────────
const app = express();
app.use(bodyParser.json());
//Optional: a simple home route so "/" doesn’t 404
app.get('/', (req, res) => {
  res.send('🤖 WhatsApp bot is running. Webhook endpoint is /webhook');
});

app.use(bodyParser.json());

// ─── 1) Webhook Verification (GET) ───────────────────────────────────────────
// This endpoint is used by Facebook/Meta to verify your webhook.
app.get('/webhook', (req, res) => {
  const mode       = req.query['hub.mode'];
  const token      = req.query['hub.verify_token'];
  const challenge  = req.query['hub.challenge'];

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

    // Check that this is a message event
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
              const from = message.from;              // sender’s WhatsApp ID (e.g. “2637712345678”)
              const msgBody = message.text?.body;     // text of the message, if any
              const messageType = message.type;       // “text”, “button”, “interactive”, etc.

              console.log(`📩 Received message from ${from}:`, messageType, msgBody);

              // Handle only text messages to keep this example simple
              if (messageType === 'text') {
                await handleIncomingText(from, msgBody);
              }

              // You could also detect “interactive” responses here:
              // if (messageType === 'interactive') { /* interactive handling */ }
            }
          }
        }
      }

      // Return a 200 OK to Meta immediately
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
  text = text.trim().toLowerCase();

  // If user requests “menu” or “hello”, send the main interactive list
  if (text === 'menu' || text === 'hello' || text === 'hi') {
    return sendMainMenu(from);
  }

  // If user says “1” or “customer relations” (fallback), start that flow
  if (text === '1' || text.includes('customer relations')) {
    userStates[from] = { submenu: 'customer_relations' };
    return sendCustomerRelationsMenu(from);
  }

  // If user says “2” or “billing” (fallback), start billing flow
  if (text === '2' || text.includes('billing')) {
    userStates[from] = { step: 1, process: 'billing_enquiry' };
    return sendTextMessage(from, 'Please enter your account number:');
  }

  // If user is already in a flow, forward to the appropriate handler
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

  // Fallback: user typed something we didn’t recognize
  return sendTextMessage(from, 'Sorry, I didn’t understand. Type “menu” to see options.');
}

// ─── 4) Send a Simple Text Message ──────────────────────────────────────────
async function sendTextMessage(to, body) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    text: { body }
  };

  try {
    await axios.post(WH_API_BASE, payload, {
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`✅ Sent text to ${to}: "${body}"`);
  } catch (err) {
    console.error('❌ Error sending text message:', err.response?.data || err.message);
  }
}

// ─── 5) Send the Main Interactive List ──────────────────────────────────────
async function sendMainMenu(to) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Ruwa Local Board Services' },
      body:   { text: 'How can we help you today?' },
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
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`✅ Sent main menu to ${to}`);
  } catch (err) {
    console.error('❌ Error sending main menu:', err.response?.data || err.message);
  }
}

// ─── 6) Send Customer Relations Sub‐Menu ────────────────────────────────────
async function sendCustomerRelationsMenu(to) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
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
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`✅ Sent Customer Relations menu to ${to}`);
  } catch (err) {
    console.error('❌ Error sending customer menu:', err.response?.data || err.message);
  }
}

// ─── 7) In‐Memory State for Each User ────────────────────────────────────────
/**
 * Structure:
 * userStates[from] = {
 *   submenu: 'customer_relations'         // if in that sub‐menu
 *   step: <number>,                       // which step of a multi‐step flow
 *   process: 'query' | 'complaint' | 'suggestion' | 'billing_enquiry',
 *   // plus any interim data (e.g. fullName, address, email, category, etc.)
 * }
 */

// ─── 8) Query Flow (5 steps + confirmation) ─────────────────────────────────
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
      return sendTextMessage(
        from,
        'Step 4/5: Choose a category by number:\n' +
        '1. Grave (Cemetery)\n2. Water Services\n3. Development Permit Processing\n4. Rates Clearance\n' +
        '5. Payment of Supplier Creditors\n6. Debt Collection\n7. Health Services at Clinics\n' +
        '8. Lease Extension Agreements\n9. Tariffs\n10. Meter Reading\n11. Sewer Services\n' +
        '12. Building Inspectorate\n13. Roads Management\n14. Public Relations Services\n15. Transport Management\n\n' +
        'Reply with the number (1–15).'
      );

    case 4:
      const catNum = parseInt(text, 10);
      if (isNaN(catNum) || catNum < 1 || catNum > 15) {
        return sendTextMessage(from, 'Invalid category number. Reply 1–15.');
      }
      state.category = catNum;
      state.step = 5;
      return sendTextMessage(from, 'Step 5/5: Enter your query description:');

    case 5:
      state.query = text;
      // Show summary first
      await sendTextMessage(
        from,
        `Name: ${state.fullName}\n` +
        `Address: ${state.address}\n` +
        `Email: ${state.email}\n` +
        `Category: ${getCategoryName(state.category)}\n` +
        `Query: ${state.query}`
      );
      // Then send confirmation buttons
      return sendConfirmationButtons(from);

    case 6:
      // Waiting for user to tap confirm/cancel button
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
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`✅ Sent confirmation buttons to ${to}`);
    // Mark step=6 so that when “confirm_yes” arrives, we finalize
    userStates[to].step = 6;
  } catch (err) {
    console.error('❌ Error sending confirmation buttons:', err.response?.data || err.message);
  }
}

async function finalizeQuerySubmission(from) {
  const state = userStates[from];
  const queryId = generateQueryId();

  try {
    // 1) Insert into DB
    const [insertResult] = await pool.query(
      `INSERT INTO queries 
         (full_name, address, email, category_id, description, query_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'OPEN', NOW(), NOW())`,
      [
        state.fullName,
        state.address,
        state.email,
        state.category,
        state.query,
        queryId
      ]
    );
    const newQueryPK = insertResult.insertId;

    // 2) Find staff for this category
    const [staffRows] = await pool.query(
      `SELECT s.id, s.name, s.email 
       FROM staff s
       JOIN category_assignments ca ON ca.staff_id = s.id
       WHERE ca.category_id = ?`,
      [state.category]
    );

    if (!staffRows.length) {
      await sendTextMessage(from, `Query logged as ${queryId}, but no staff assigned yet.`);
    } else {
      const assignedStaff = staffRows[0];
      // 3) Update query with assigned staff
      await pool.query(
        `UPDATE queries
           SET assigned_to = ?, status = 'ASSIGNED', updated_at = NOW()
         WHERE id = ?`,
        [assignedStaff.id, newQueryPK]
      );
      // 4) Log activity
      await pool.query(
        `INSERT INTO query_activity
           (query_id, action, performed_by, created_at)
         VALUES (?, 'ASSIGNED', ?, NOW())`,
        [newQueryPK, assignedStaff.id]
      );

      // 5) Send email to staff
      const htmlBody = `
        <p>Hello ${assignedStaff.name},</p>
        <p>A new query (<strong>${queryId}</strong>) has been assigned to you:</p>
        <ul>
          <li>Category: ${getCategoryName(state.category)}</li>
          <li>From: ${state.fullName} (${state.email})</li>
          <li>Address: ${state.address}</li>
          <li>Query: ${state.query}</li>
        </ul>
        <p>Please <a href="https://portal.ruwalocalboard.co.zw/queries.php">log in to the portal</a> to update its status.</p>
        <p>Thank you.</p>`;
      await sendEmail(assignedStaff.email, `New Query Assigned: ${queryId}`, htmlBody);

      // 6) Reply back to user on WhatsApp
      await sendTextMessage(from,
        `✅ Query Successfully Logged\nYour Query ID is *${queryId}*.\n\n` +
        `It has been assigned to ${assignedStaff.name}. They will reach out soon.`
      );
    }
  } catch (err) {
    console.error('❌ DB error saving query:', err);
    await sendTextMessage(from, '⚠️ System error. Please try again later.');
  }

  delete userStates[from];
}

// ─── 9) Complaint Flow (3 steps) ───────────────────────────────────────────
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

// ─── 10) Suggestion Flow (3 steps) ─────────────────────────────────────────
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

// ─── 11) Billing Flow (3 steps + PDF) ──────────────────────────────────────
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
        // 1) Login
        const loginRes = await axios.post(
          'https://portal.ruwalocalboard.co.zw/data/login2.php',
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
        const cookies = loginRes.headers['set-cookie'];
        if (!Array.isArray(cookies) || !cookies.length) {
          await sendTextMessage(from, '❌ Login succeeded but no session cookie was returned.');
          delete userStates[from];
          return;
        }
        state.cookieString = cookies.map(c => c.split(';')[0]).join('; ');

        // 2) Fetch bill data
        const billRes = await axios.get('https://portal.ruwalocalboard.co.zw/api.php', {
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
                     `View full statement: https://portal.ruwalocalboard.co.zw`;

        await sendTextMessage(from, replyText);

        // 4) Show PDF Yes/No buttons
        state.step = 4;
        const PDF_BUTTONS = {
          messaging_product: 'whatsapp',
          to: from,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: 'Would you like your PDF statement?' },
            footer: { text: '' },
            action: {
              buttons: [
                {
                  type: 'reply',
                  reply: { id: 'pdf_yes', title: 'Yes, send PDF' }
                },
                {
                  type: 'reply',
                  reply: { id: 'pdf_no', title: 'No thanks' }
                }
              ]
            }
          }
        };
        await axios.post(WH_API_BASE, PDF_BUTTONS, {
          headers: {
            'Authorization': `Bearer ${TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
        console.log(`✅ Sent PDF buttons to ${from}`);
      } catch (err) {
        console.error('❌ Billing error:', err);
        await sendTextMessage(from, '⚠️ Error fetching bill details. Please try again later.');
        delete userStates[from];
      }
      return;

    case 4:
      // Waiting for user to tap “pdf_yes” or “pdf_no”
      return sendTextMessage(from, 'Please tap one of the buttons to continue.');

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

function logComplaint(complaint) {
  console.log('Complaint Logged:', complaint);
}

function logSuggestion(suggestion) {
  console.log('Suggestion Logged:', suggestion);
}

// ─── Start Express Server & Graceful Shutdown ──────────────────────────────
async function startClient() {
  app.listen(PORT, () => {
    console.log(`🚀 Server is listening on http://localhost:${PORT}`);
  });
}

startClient();

process.on('SIGINT', async () => {
  console.log('🛑 Shutting down gracefully…');
  process.exit(0);
});
