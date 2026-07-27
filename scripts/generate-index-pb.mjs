import fs from "node:fs";

const root = new URL("../", import.meta.url);
const index = JSON.parse(fs.readFileSync(new URL("index.json", root), "utf8"));
const rawBase = "https://raw.githubusercontent.com/chuoinho/truyen-repo/refs/heads/repo";
const signingKey = "1db5710ee3c6ac5bd45b89d0351083525373a0f8827f500f832a595ecdc97aca";

const concat = (...parts) => Buffer.concat(parts.filter((part) => part.length));

function varint(value) {
  let number = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(number & 0x7fn);
    number >>= 7n;
    if (number) byte |= 0x80;
    bytes.push(byte);
  } while (number);
  return Buffer.from(bytes);
}

const key = (field, wireType) => varint((field << 3) | wireType);
const intField = (field, value) => value ? concat(key(field, 0), varint(value)) : Buffer.alloc(0);
const bytesField = (field, value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return bytes.length ? concat(key(field, 2), varint(bytes.length), bytes) : Buffer.alloc(0);
};

function encodeSource(source, nsfw = false) {
  return concat(
    intField(1, BigInt(source.id)),
    bytesField(2, source.name),
    bytesField(3, source.lang),
    bytesField(4, source.baseUrl || ""),
    intField(6, nsfw ? 3 : 0),
  );
}

function encodeExtensionBase(extension) {
  const resources = concat(
    bytesField(1, `${rawBase}/apk/${extension.apk}`),
    bytesField(2, `${rawBase}/icon/${extension.pkg}.png`),
  );
  return {
    fields: concat(
    bytesField(1, extension.name.replace(/^Tachiyomi:\s*/, "")),
    bytesField(2, extension.pkg),
    bytesField(3, resources),
    bytesField(4, "1.4"),
    intField(5, extension.code),
    bytesField(6, extension.version),
    ),
    resources,
  };
}

function encodeLegacyExtension(extension) {
  const { fields } = encodeExtensionBase(extension);
  return concat(
    fields,
    ...extension.sources.map((source) => bytesField(7, encodeSource(source, extension.nsfw))),
  );
}

function encodeCurrentExtension(extension) {
  const { fields } = encodeExtensionBase(extension);
  return concat(
    fields,
    intField(7, extension.nsfw ? 3 : 1),
    ...extension.sources.map((source) => bytesField(8, encodeSource(source))),
  );
}

const legacyExtensions = index.map(encodeLegacyExtension);
const currentExtensions = index.map(encodeCurrentExtension);
const contact = bytesField(1, "https://github.com/chuoinho/truyen-repo");
const extensionList = concat(...currentExtensions.map((extension) => bytesField(1, extension)));
const output = concat(
  bytesField(1, "Truyen Repo"),
  bytesField(2, "Truyen"),
  bytesField(3, signingKey),
  bytesField(4, contact),
  ...legacyExtensions.map((extension) => bytesField(5, extension)),
  bytesField(101, extensionList),
);

fs.writeFileSync(new URL("index.pb", root), output);
