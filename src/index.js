import { fromHex, getAddress, stringToHex } from "viem";
import { ethers } from "ethers";

// Cartesi Rollup server configuration
const ROLLUP_SERVER_URL =
  process.env.ROLLUP_HTTP_SERVER_URL || "http://localhost:5004";

// In-memory balance storage (key: wallet address, value: balance in wei)
const balances = {};

//-------------------------------------
// Utility Functions
//-------------------------------------

/**
 * Sends a NOTICE to the Cartesi Rollup server.
 * This serves as an event that can be proven on-chain.
 * @param {string} message - Message to send.
 */
async function sendNotice(message) {
  const payload = stringToHex(message);
  const response = await fetch(`${ROLLUP_SERVER_URL}/notice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload }),
  });

  console.log(`${JSON.stringify(response)}`);
  console.log(`[NOTICE] Sent: ${payload}`);
}

/**
 * Sends a REPORT to the Cartesi Rollup server.
 * Reports are stateless logs useful for debugging but not provable on-chain.
 * @param {string} message - Message to send.
 */
async function sendReport(message) {
  const payload = stringToHex(message);
  await fetch(`${ROLLUP_SERVER_URL}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload }),
  });
  console.log(`[REPORT] Sent: ${payload}`);
}

/**
 * Parses the deposit payload to extract the recipient address and amount.
 * @param {string} payload - The deposit payload in hex format.
 * @returns {[string, bigint]} - The parsed recipient address and deposit amount.
 */
function parseDepositPayload(payload) {
  try {
    const addressData = ethers.getBytes(payload).slice(0, 20); // First 20 bytes = recipient address
    const amountData = ethers.getBytes(payload).slice(20, 52); // Next 32 bytes = deposit amount

    if (!addressData || addressData.length !== 20) {
      throw new Error("Invalid deposit payload: Address extraction failed.");
    }

    const recipient = getAddress(ethers.hexlify(addressData)); // Convert to EIP-55 address format
    const amount = BigInt(ethers.hexlify(amountData)); // Convert hex to bigint

    return [recipient, amount];
  } catch (error) {
    throw new Error(`Error parsing deposit payload: ${error.message}`);
  }
}

/**
 * Processes a deposit and updates the recipient's balance.
 * @param {string} recipient - Recipient's Ethereum address.
 * @param {bigint} amount - Deposit amount in wei.
 */
function processDeposit(recipient, amount) {
  if (!recipient || amount == null) {
    throw new Error("Missing recipient or amount in deposit request.");
  }

  if (!balances[recipient]) {
    balances[recipient] = BigInt(0);
  }

  balances[recipient] += amount;

  console.log(
    `[DEPOSIT] ${recipient} new balance = ${balances[recipient]} wei`
  );
}

//-------------------------------------
// Handler for ADVANCE (state-changing inputs)
//-------------------------------------

async function handleAdvance(requestData) {
  try {
    console.log("----- requestData ------");
    console.log(requestData, requestData.payload);

    // Extract sender from metadata (who initiated the deposit)
    const sender = requestData.metadata.msg_sender;

    // Parse the recipient address and amount from the payload
    const [recipient, amount] = parseDepositPayload(requestData.payload);

    console.log(
      `[ADVANCE] Deposit received: sender=${sender}, recipient=${recipient}, amount=${amount} wei`
    );

    // Process the deposit and update recipient's balance
    processDeposit(recipient, amount);

    // Notify the Cartesi Rollup server
    await sendNotice(
      `Deposit OK: recipient=${recipient}, newBalance=${balances[recipient]}`
    );

    return "accept";
  } catch (err) {
    console.error("[ADVANCE] Error:", err.message);
    await sendReport(`Error: ${err.message}`);
    return "reject";
  }
}

//-------------------------------------
// Handler for INSPECT (read-only queries)
//-------------------------------------

async function handleInspect(requestData) {
  try {
    console.log("----- Inspect request ------");
    console.log(requestData, requestData.payload);

    // Decode the hex payload into a JSON string
    const decodedString = fromHex(requestData.payload, "string");

    console.log("------ Decoded String -----");
    console.log(decodedString);

    // Parse JSON into an object
    const parsed = JSON.parse(decodedString);

    console.log("------ Parsed Object -----");
    console.log(parsed);

    // Expecting { action: "balance", user: "0x..." } to query a balance
    if (parsed.action === "balance" && parsed.user) {
      const userBalance = balances[parsed.user] || BigInt(0);

      console.log(
        `[INSPECT] Balance query: user=${parsed.user}, balance=${userBalance} wei`
      );

      // Send a report back with the balance
      await sendReport(`Balance of ${parsed.user} = ${userBalance} wei`);
    } else {
      console.log("[INSPECT] Unknown action or missing user field");
    }

    return "accept";
  } catch (err) {
    console.error("[INSPECT] Error:", err.message);
    await sendReport(`Error: ${err.message}`);
    console.log(err);
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
  let resultStatus = "accept";

  // We'll continuously ask /finish for new requests
  while (true) {
    // By default, we send 'accept' to fetch next request
    // After handling, we finalize by sending the resultStatus back to /finish
    const finishResp = await fetch(`${ROLLUP_SERVER_URL}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: resultStatus }),
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

    if (request_type === "advance_state") {
      resultStatus = await handleAdvance(data);
    } else if (request_type === "inspect_state") {
      resultStatus = await handleInspect(data);
    } else {
      console.log(`[MAINLOOP] Unknown request_type=${request_type}`);
    }
  }
})();
