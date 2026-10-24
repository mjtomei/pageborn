# English word frequencies

`en.json` is a filtered/reformatted subset of the English large frequency list
from **wordfreq 3.1.1, by Robyn Speer**: https://github.com/rspeer/wordfreq.
This derived data remains **CC BY-SA 4.0**:
https://creativecommons.org/licenses/by-sa/4.0/.
See `DATA-LICENSE.txt` and `NOTICE.md` for the license and corpus attributions.
The accompanying upstream `LICENSE.txt` covers wordfreq's code, not this data.

Changes: keep single lexical entries up to 60 characters at Zipf >= 2.5;
store each frequency as integer Zipf × 100 with space-separated words. Lower
frequencies need not be stored because Pageborne caps their rarity equally.
The data is separate from Pageborne's source code and is also distributed as
an independently reusable JSON file in `licenses/wordfreq/` in built packages.

Regenerate with `python scripts/prepare-word-frequency.py` in a development
environment containing `wordfreq==3.1.1`. No Python or network lookup is used
on the phone. The script verifies the original data's SHA-256:
`dffae8066b78dce0a6667cf5f58e567054f902674667090a7ac8a8a44628b05c`.

Upstream notices copied from revision
`912caf64b657478d1dff1138efdc078947d54bb1` (2026-10-05).
