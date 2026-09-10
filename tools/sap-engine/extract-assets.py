"""Extract digest-pinned public Apple files; never execute the downloaded code.

Format/offset reference: ipatool v2.4.0 internal/sap/assets (MIT).
Only the four exact allowlisted archive members are written, to fixed names.
Run: python3 tools/sap-engine/extract-assets.py frontend/public/sap-assets
"""
import bz2
import hashlib
import io
import json
from pathlib import Path
import struct
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zlib

UPDATE_URL = ('https://swcdn.apple.com/content/downloads/27/34/'
              '041-98128-A_SYPWICN3KH/5dqkl4rqgbsr18yzy61yeie9g3cmjc5hiv/OSXUpd10.9.pkg')
PAYLOAD_BZIP_OFFSET = 0x352F40D5
CPIO_SKIP = 0x3A4
ROOT = Path(__file__).resolve().parents[2]
SPECS = json.loads((ROOT / 'frontend/src/apple/sap/asset-manifest.json').read_text())


def open_range(start, end):
    request = urllib.request.Request(UPDATE_URL, headers={'Range': f'bytes={start}-{end}'})
    response = urllib.request.urlopen(request, timeout=120)
    if response.status != 206 or not response.headers.get('Content-Range', '').startswith(f'bytes {start}-'):
        response.close()
        raise ValueError('Apple CDN did not honor the byte range')
    return response


def exact(stream, length):
    chunks = []
    remaining = length
    while remaining:
        chunk = stream.read(min(remaining, 65536))
        if not chunk:
            raise EOFError('Truncated Apple archive')
        chunks.append(chunk)
        remaining -= len(chunk)
    return b''.join(chunks)


class Payload(io.RawIOBase):
    """Bounded streaming bzip2 reader starting at the known Apple block."""
    def __init__(self, remote):
        self.remote = remote
        self.decoder = bz2.BZ2Decompressor()
        self.decoder.decompress(b'BZh9')

    def readable(self):
        return True

    def readinto(self, target):
        while True:
            data = self.remote.read(65536) if self.decoder.needs_input else b''
            if not data and self.decoder.needs_input:
                return 0
            decoded = self.decoder.decompress(data, max_length=len(target))
            if decoded:
                target[:len(decoded)] = decoded
                return len(decoded)
            if self.decoder.eof:
                return 0


def discard(stream, length):
    while length:
        chunk = exact(stream, min(length, 65536))
        length -= len(chunk)


def extract(destination):
    destination.mkdir(parents=True, exist_ok=True)
    if all((destination / s['name']).is_file() and
           hashlib.sha256((destination / s['name']).read_bytes()).hexdigest() == s['sha256']
           for s in SPECS):
        print('Apple assets already verified')
        return
    with open_range(0, 27) as response:
        header = exact(response, 28)
    magic, header_size, version, compressed_size, plain_size, _ = struct.unpack('>4sHHQQI', header)
    if magic != b'xar!' or version != 1 or header_size != 28 or compressed_size > 4 << 20 or plain_size > 16 << 20:
        raise ValueError('Unexpected XAR header')
    with open_range(header_size, header_size + compressed_size - 1) as response:
        toc = ET.fromstring(zlib.decompress(exact(response, compressed_size)))
    payload = next(item for item in toc.iter('file') if item.findtext('name') == 'Payload')
    heap_start = header_size + compressed_size
    payload_offset = int(payload.findtext('data/offset'))
    payload_size = int(payload.findtext('data/length'))
    start = heap_start + payload_offset + PAYLOAD_BZIP_OFFSET
    end = heap_start + payload_offset + payload_size - 1
    wanted = {s['path']: s for s in SPECS}
    found = set()
    with open_range(start, end) as response:
        stream = io.BufferedReader(Payload(response), buffer_size=65536)
        discard(stream, CPIO_SKIP)
        while len(found) != len(wanted):
            magic = exact(stream, 6)
            if magic == b'070707':
                header = magic + exact(stream, 70)
                name_size = int(header[59:65], 8)
                file_size = int(header[65:76], 8)
                alignment, header_length = 1, 76
            elif magic in (b'070701', b'070702'):
                header = magic + exact(stream, 104)
                name_size = int(header[94:102], 16)
                file_size = int(header[54:62], 16)
                alignment, header_length = 4, 110
            else:
                raise ValueError(f'Unsupported CPIO header {magic!r}')
            if not 1 <= name_size <= 4096:
                raise ValueError('Invalid CPIO name length')
            name = exact(stream, name_size).rstrip(b'\0').decode('utf-8')
            discard(stream, -(header_length + name_size) % alignment)
            if name == 'TRAILER!!!':
                raise ValueError('Missing required Apple components')
            spec = wanted.get(name)
            if spec:
                if file_size != spec['size']:
                    raise ValueError(f'Unexpected size for {spec["name"]}')
                data = exact(stream, file_size)
                if hashlib.sha256(data).hexdigest() != spec['sha256']:
                    raise ValueError(f'Integrity verification failed: {spec["name"]}')
                temporary = destination / (spec['name'] + '.partial')
                temporary.write_bytes(data)
                temporary.replace(destination / spec['name'])
                found.add(name)
                print(f'Verified {spec["name"]}', flush=True)
            else:
                discard(stream, file_size)
            discard(stream, -file_size % alignment)
        # The partial bzip2 stream lacks its original prefix/CRC. Stop only
        # after every complete output has independently passed SHA-256.


if __name__ == '__main__':
    extract(Path(sys.argv[1]))
