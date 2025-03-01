const { pbkdf2Sync } = require("crypto");
const { HDKey } = require("@scure/bip32");

/**
 * Deriva claves privadas de una frase “arbitraria” al estilo Foundry:
 * - seed = PBKDF2(mnemonic, "mnemonic" + passphrase, 2048, 64, 'sha512')
 * - Cada cuenta = m/44'/60'/0'/0/i
 *
 * @param {string} mnemonic - La frase (o palabras) que Foundry acepta.
 * @param {string} [passphrase=""] - La passphrase adicional (opcional).
 * @param {number} [count=10] - Número de cuentas a derivar.
 * @returns {string[]} - Claves privadas en formato hex (0x...).
 */
function deriveFoundryAccounts(mnemonic, passphrase = "", count = 10) {
  // 1) Generar el seed via PBKDF2
  const salt = "mnemonic" + passphrase;
  const seed = pbkdf2Sync(mnemonic, salt, 2048, 64, "sha512");

  // 2) Crear master key HD (bip32) a partir del seed
  const masterKey = HDKey.fromMasterSeed(seed);

  // 3) Derivar N cuentas según la ruta m/44'/60'/0'/0/i
  const privateKeys = [];
  for (let i = 0; i < count; i++) {
    const child = masterKey.derive(`m/44'/60'/0'/0/${i}`);
    const pk = "0x" + Buffer.from(child.privateKey).toString("hex");
    privateKeys.push(pk);
  }

  return privateKeys;
}

// Ejemplo de uso
(function main() {
  // Es la clásica frase "invalida" que Foundry sí permite
  const mnemonic =
    "test test test test test test test test test test test junk";

  // Derivamos las primeras 10
  const pks = deriveFoundryAccounts(mnemonic);

  console.log("Pks Foundry:");
  pks.forEach((pk, i) => {
    console.log(`Account #${i}: ${pk}`);
  });
})();
