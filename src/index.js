////////////////////////////////////////////////////////////////////////////////
// Example of a Cartesi Node in JavaScript using 'viem' for hex conversions.
//
// This code listens for /advance and /inspect requests from the Cartesi framework
// and updates an internal state (in-memory balances) accordingly.
//
// Actions supported:
//   1) "deposit": e.g. {action: "deposit", sender: "0xAlice", amount: 100}
//   2) "transfer": e.g. {action: "transfer", from: "0xAlice", to: "0xBob", amount: 20}
//
// On a real production environment, you would:
//   - Use a persistent database instead of in-memory objects.
//   - Possibly refine error handling (accept vs reject).
//   - Validate that the "from" wallet has enough balance, etc.
//
// By default, we connect to the ROLLUP_HTTP_SERVER_URL environment variable.
// If not set, we fall back to "http://127.0.0.1:5004" or "http://localhost:5004",
// depending on your setup.
//
// Usage:
//   ROLLUP_HTTP_SERVER_URL="http://localhost:5004" node src/index.js
//
////////////////////////////////////////////////////////////////////////////////

const { stringToHex, hexToString } = require("viem");

// The Cartesi rollup server URL, typically "http://localhost:5004" or "http://localhost:8080"
const ROLLUP_SERVER_URL =
  process.env.ROLLUP_HTTP_SERVER_URL || "http://localhost:5004";

// In-memory dictionary to store user balances (key: wallet address, value: number)
const balances = {};

//-------------------------------------
// Utility Functions
//-------------------------------------

/**
 * Send a NOTICE to the rollup server. This is like an "event" that can be proven on-chain.
 * @param {string} message - A string message to be noticed.
 */
async function sendNotice(message) {
  const payload = stringToHex(message);
  await fetch(`${ROLLUP_SERVER_URL}/notice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload }),
  });
  console.log(`[NOTICE] Sent: ${message}`);
}

/**
 * Send a REPORT to the rollup server. Reports are "stateless logs" without proofs.
 * Useful for debugging or logging info that doesn't need proof on-chain.
 * @param {string} message - A string message to be reported.
 */
async function sendReport(message) {
  const payload = stringToHex(message);
  await fetch(`${ROLLUP_SERVER_URL}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload }),
  });
  console.log(`[REPORT] Sent: ${message}`);
}

/**
 * Process a deposit action: { action: "deposit", sender: "0x...", amount: number }
 * Increments the balance of sender by amount.
 */
function processDeposit(parsed) {
  const { sender, amount } = parsed;
  if (!sender || amount == null) {
    throw new Error("Missing 'sender' or 'amount' in deposit input");
  }
  if (!balances[sender]) {
    balances[sender] = 0;
  }
  balances[sender] += Number(amount);
  console.log(`[DEPOSIT] ${sender} new balance = ${balances[sender]}`);
}

/**
 * Process a transfer action: { action: "transfer", from: "0x...", to: "0x...", amount: number }
 * Moves 'amount' from 'from' balance to 'to' balance, if there's enough balance.
 */
function processTransfer(parsed) {
  const { from, to, amount } = parsed;
  if (!from || !to || amount == null) {
    throw new Error("Missing 'from', 'to' or 'amount' in transfer input");
  }
  if (!balances[from] || balances[from] < amount) {
    throw new Error(
      `Insufficient balance in ${from}. Current: ${
        balances[from] || 0
      }, needed: ${amount}`
    );
  }
  balances[from] -= Number(amount);
  if (!balances[to]) {
    balances[to] = 0;
  }
  balances[to] += Number(amount);

  console.log(`[TRANSFER] from=${from}, to=${to}, amount=${amount}`);
  console.log(`[BALANCES] from=${balances[from]}, to=${balances[to]}`);
}

//-------------------------------------
// Handler for ADVANCE (state-changing inputs)
//-------------------------------------
async function handleAdvance(requestData) {
  try {
    // The payload is in hex format, so we decode it to string
    const decodedString = hexToString(requestData.payload);
    console.log(`[ADVANCE] Decoded input: ${decodedString}`);

    // Parse as JSON
    const parsed = JSON.parse(decodedString);

    // Check the "action" property
    switch (parsed.action) {
      case "deposit":
        processDeposit(parsed);
        await sendNotice(
          `Deposit OK: sender=${parsed.sender}, newBalance=${
            balances[parsed.sender]
          }`
        );
        break;

      case "transfer":
        processTransfer(parsed);
        await sendNotice(
          `Transfer OK: from=${parsed.from}, to=${parsed.to}, amount=${parsed.amount}`
        );
        break;

      default:
        console.log("[ADVANCE] Unknown action, ignoring");
        // Optionally we can just accept or throw an error
        break;
    }

    // If everything is fine, return "accept"
    return "accept";
  } catch (err) {
    console.error("[ADVANCE] Error:", err.message);
    // We can send a report with the error details
    await sendReport(`Error: ${err.message}`);
    // Then decide if we want to reject or accept:
    return "reject";
  }
}

//-------------------------------------
// Handler for INSPECT (read-only queries)
//-------------------------------------
async function handleInspect(requestData) {
  try {
    // The payload is in hex format, so decode it
    const decodedString = hexToString(requestData.payload);
    console.log(`[INSPECT] Decoded input: ${decodedString}`);

    // Parse as JSON
    const parsed = JSON.parse(decodedString);

    // Let's say we expect { action: "balance", user: "0x..." } to query a balance
    if (parsed.action === "balance" && parsed.user) {
      const bal = balances[parsed.user] || 0;
      // We'll send a report back with the balance
      await sendReport(`Balance of ${parsed.user} = ${bal}`);
    } else {
      console.log("[INSPECT] Unknown or no user specified");
      // We can still accept
    }

    // Everything is fine
    return "accept";
  } catch (err) {
    console.error("[INSPECT] Error:", err.message);
    // We can decide to reject or accept
    return "reject";
  }
}

//-------------------------------------
// Main Loop
//-------------------------------------
(async function mainLoop() {
  console.log(
    "Cartesi Node started. Listening for rollup requests at:",
    ROLLUP_SERVER_URL
  );

  // We'll continuously ask /finish for new requests
  while (true) {
    // By default, we send 'accept' to fetch next request
    const finishResp = await fetch(`${ROLLUP_SERVER_URL}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "accept" }),
    });

    if (finishResp.status === 202) {
      // 202 means: no new requests right now
      // let's wait a bit before trying again
      console.log("[MAINLOOP] No pending requests, retry in 1s...");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    // If it's not 202, then we got a request
    const rollupRequest = await finishResp.json();
    const { request_type, data } = rollupRequest;

    console.log(`[MAINLOOP] Received request_type=${request_type}`);

    let resultStatus = "accept";

    if (request_type === "advance_state") {
      resultStatus = await handleAdvance(data);
    } else if (request_type === "inspect_state") {
      resultStatus = await handleInspect(data);
    } else {
      console.log(`[MAINLOOP] Unknown request_type=${request_type}`);
    }

    // After handling, we finalize by sending the resultStatus back to /finish
    await fetch(`${ROLLUP_SERVER_URL}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: resultStatus }),
    });
  }
})();
