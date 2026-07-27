const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Create a 32x32 RGBA PNG icon with a vibrant blue/cyan logo
const width = 32;
const height = 32;

// CRC32 calculation table
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[n] = c;
}

function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'binary');
    const crcBuf = Buffer.alloc(4);
    const typeAndData = Buffer.concat([typeBuf, data]);
    crcBuf.writeUInt32BE(crc32(typeAndData), 0);
    return Buffer.concat([lenBuf, typeAndData, crcBuf]);
}

// Build raw RGBA pixels
const rawPixels = Buffer.alloc(height * (1 + width * 4));

for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    rawPixels[rowOffset] = 0; // Filter type 0 (None)
    for (let x = 0; x < width; x++) {
        const pixelOffset = rowOffset + 1 + x * 4;
        
        // Distance from center (15.5, 15.5)
        const dx = x - 15.5;
        const dy = y - 15.5;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist <= 14) {
            // Bright glowing cyan/blue icon body (#0078d4 to #00bcf2)
            if (dist <= 5) {
                // White inner core logo
                rawPixels[pixelOffset] = 255;   // R
                rawPixels[pixelOffset + 1] = 255; // G
                rawPixels[pixelOffset + 2] = 255; // B
                rawPixels[pixelOffset + 3] = 255; // A
            } else if (Math.abs(dx) <= 2 || Math.abs(dy) <= 2) {
                // White cross lines
                rawPixels[pixelOffset] = 255;
                rawPixels[pixelOffset + 1] = 255;
                rawPixels[pixelOffset + 2] = 255;
                rawPixels[pixelOffset + 3] = 255;
            } else {
                // Vibrant Azure Blue background
                rawPixels[pixelOffset] = 0;     // R
                rawPixels[pixelOffset + 1] = 120; // G
                rawPixels[pixelOffset + 2] = 212; // B
                rawPixels[pixelOffset + 3] = 255; // A
            }
        } else {
            // Transparent background
            rawPixels[pixelOffset] = 0;
            rawPixels[pixelOffset + 1] = 0;
            rawPixels[pixelOffset + 2] = 0;
            rawPixels[pixelOffset + 3] = 0;
        }
    }
}

// Compress scanlines with zlib
const idatData = zlib.deflateSync(rawPixels);

// Build IHDR chunk
const ihdrBuf = Buffer.alloc(13);
ihdrBuf.writeUInt32BE(width, 0);
ihdrBuf.writeUInt32BE(height, 4);
ihdrBuf[8] = 8;  // bit depth
ihdrBuf[9] = 6;  // color type RGBA
ihdrBuf[10] = 0; // compression
ihdrBuf[11] = 0; // filter
ihdrBuf[12] = 0; // interlace

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdrChunk = makeChunk('IHDR', ihdrBuf);
const idatChunk = makeChunk('IDAT', idatData);
const iendChunk = makeChunk('IEND', Buffer.alloc(0));

const pngBuffer = Buffer.concat([pngSignature, ihdrChunk, idatChunk, iendChunk]);

const outDir = path.join(__dirname, '..', 'src', 'gui');
if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}
const outFile = path.join(outDir, 'icon.png');
fs.writeFileSync(outFile, pngBuffer);
console.log('Successfully generated 32x32 PNG icon at:', outFile);
