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
 * @param {string} message - Message to send.
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
 * Sends a REPORT to the Cartesi Rollup server.
 * @param {string} message - Message to send.
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
 * Generates a voucher for the given recipient and amount.
 * @param {string} recipient - The Ethereum address to which the voucher is directed.
 * @param {bigint} amount - The amount in wei.
 */
async function generateVoucher(recipient, amount) {
  // Format the payload expected by Cartesi:
  // "destination" is the address, "payload" is the data (in this case the amount in 32 bytes)
  const payload = {
    destination: recipient,
    payload: ethers.toBeHex(amount, 32),
  };

  await fetch(`${ROLLUP_SERVER_URL}/voucher`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  console.log(`[VOUCHER] Sent: ${JSON.stringify(payload)}`);
}

//-------------------------------------
// Deposit-related logic
//-------------------------------------

/**
 * Parses the deposit payload to extract the recipient address and amount.
 * The payload should be 52 bytes: first 20 for recipient, next 32 for amount.
 * @param {string} payload - The deposit payload in hex format.
 * @returns {[string, bigint]} - The parsed recipient address and deposit amount.
 */
function parseDepositPayload(payload) {
  try {
    // Convert hex string to bytes
    const bytes = ethers.getBytes(payload);

    // Expect 52 bytes: 20 for address, 32 for amount
    if (bytes.length < 52) {
      throw new Error("Payload too short for a deposit.");
    }

    const addressData = bytes.slice(0, 20);
    const amountData = bytes.slice(20, 52);

    const recipient = getAddress(ethers.hexlify(addressData));
    const amount = BigInt(ethers.hexlify(amountData));

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
// Handler for ADVANCE
//-------------------------------------

async function handleAdvance(requestData) {
  try {
    console.log("----- requestData ------");
    console.log(requestData, requestData.payload);

    // Let's decode payload as a string
    const decodedString = fromHex(requestData.payload, "string");

    // We attempt to parse the decoded string as JSON. If it fails,
    // we assume it's a deposit payload.
    let parsed;
    let isJson = false;
    try {
      parsed = JSON.parse(decodedString);
      isJson = true;
    } catch (jsonErr) {
      // not JSON => deposit
    }

    if (isJson && parsed && typeof parsed === "object") {
      // If we have JSON that includes "win" and "loss", we'll treat it as a voucher scenario
      if (parsed.win && parsed.loss) {
        const winner = getAddress(parsed.win);
        const loser = getAddress(parsed.loss);
        const loserBalance = balances[loser] || BigInt(0);

        if (loserBalance > 0) {
          // Generate voucher from loser to winner
          await generateVoucher(winner, loserBalance);

          // Reset loser's balance
          balances[loser] = BigInt(0);
          console.log(
            `[ADVANCE] Voucher created: ${winner} receives ${loserBalance} wei from ${loser}`
          );

          await sendNotice(
            `Voucher issued: ${winner} gets ${loserBalance} wei`
          );
        } else {
          console.log(`[ADVANCE] Loser ${loser} has no balance to transfer.`);
          await sendReport(`Loser ${loser} has no balance to transfer.`);
        }
      } else {
        // If the JSON doesn't have "win" and "loss", we can decide how to handle it
        // For now, let's just report an unknown action.
        console.log(
          `[ADVANCE] JSON payload unrecognized structure: ${decodedString}`
        );
        await sendReport(`Unrecognized JSON structure: ${decodedString}`);
      }
    } else {
      // Not JSON => assume deposit
      const [recipient, amount] = parseDepositPayload(requestData.payload);

      // For logging, note who sent it
      const sender = requestData.metadata.msg_sender;
      console.log(
        `Deposit from sender=${sender}, recipient=${recipient}, amount=${amount}`
      );

      processDeposit(recipient, amount);

      await sendNotice(
        `Deposit OK: recipient=${recipient}, newBalance=${balances[recipient]}`
      );
    }

    return "accept";
  } catch (err) {
    console.error("[ADVANCE] Error:", err.message);
    await sendReport(`Error: ${err.message}`);
    return "reject";
  }
}

//-------------------------------------
// Handler for INSPECT
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
