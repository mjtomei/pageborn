"""Regenerate the offline English lookup; requires wordfreq==3.1.1 (dev only)."""
import gzip
import hashlib
import importlib.metadata
import json
from pathlib import Path

import msgpack
import wordfreq

assert importlib.metadata.version('wordfreq') == '3.1.1'
source = Path(wordfreq.__file__).parent / 'data/large_en.msgpack.gz'
digest = hashlib.sha256(source.read_bytes()).hexdigest()
assert digest == 'dffae8066b78dce0a6667cf5f58e567054f902674667090a7ac8a8a44628b05c'
data = msgpack.unpackb(gzip.decompress(source.read_bytes()), raw=False)
assert data[0] == {'format': 'cB', 'version': 1}
buckets = []
for index, words in enumerate(data[1:]):
    zipf = 900 - index
    if zipf < 250:
        break  # Rarer/absent words share the ranking's bounded maximum rarity.
    words = [word for word in words if len(word) <= 60 and any(c.isalpha() for c in word)
             and all(c.isalpha() or c.isdecimal() or c in "'’.-" for c in word)]
    if words:
        buckets.append([zipf, ' '.join(words)])
output = Path(__file__).resolve().parent.parent / 'vendor/wordfreq/en.json'
output.write_text(json.dumps(buckets, ensure_ascii=False, separators=(',', ':')) + '\n')
print(f'{sum(len(words.split()) for _, words in buckets)} entries; {output.stat().st_size} bytes')
