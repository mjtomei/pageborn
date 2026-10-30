"""Transfer supported Xiaomi word corrections onto measured OCR geometry.

The model has no word boxes. Never invent positions, delete unaligned text, or
replace tables/figures from a model description. Preserve omissions for review.
"""
import copy
import difflib
import re


def core(word):
    return re.sub(r'[^\w]', '', word, flags=re.UNICODE).casefold()


def correct(extracted, markdown):
    result = copy.deepcopy(extracted)
    words = [word for line in result['text'] for word in line.get('words', [])]
    # Strip formatting, not punctuation. Structured tables/formulas have no
    # trustworthy word-to-pixel mapping; leave those regions to the PDF pipeline.
    prose = re.sub(r'<[^>]*>|\$\$[\s\S]*?\$\$', ' ', markdown)
    target = [w.strip('*`#_') for w in prose.split()]
    target = [w for w in target if core(w)]
    source = [core(w['text']) for w in words]
    folded = [core(w) for w in target]
    if not source or len(source) > 6000 or len(target) > 6000:
        return result
    matcher = difflib.SequenceMatcher(None, source, folded, autojunk=False)
    # Refuse a wholesale rewrite, wrong page, or unrelated model response.
    if matcher.ratio() < .65:
        return result
    ops = matcher.get_opcodes()
    replacements = {}
    for index, (kind, a, b, c, d) in enumerate(ops):
        if kind == 'equal':
            for i, j in zip(range(a, b), range(c, d)):
                # Case only, preserving printed punctuation and reference marks.
                before = words[i]['text']; after = target[j]
                if before != after and before.casefold() == after.casefold(): replacements[i] = after
        elif kind == 'replace' and b-a == d-c and b-a <= 3:
            left = index > 0 and ops[index-1][0] == 'equal' and ops[index-1][2]-ops[index-1][1] >= 2
            right = index+1 < len(ops) and ops[index+1][0] == 'equal' and ops[index+1][2]-ops[index+1][1] >= 2
            if not (left and right): continue
            for i, j in zip(range(a, b), range(c, d)):
                before, after = source[i], folded[j]
                if (any(ch.isalpha() for ch in after) and len(after) <= 40
                        and difflib.SequenceMatcher(None, before, after).ratio() >= .45):
                    replacements[i] = target[j]
    index = 0
    for line in result['text']:
        text, offset = line['text'], 0
        for word in line.get('words', []):
            before = word['text']; at = text.find(before, offset)
            if index in replacements and at >= 0:
                word.update(text=replacements[index], ocrOriginal=before, desktopOcr=True)
                text = text[:at] + word['text'] + text[at+len(before):]
            if at >= 0: offset = at + len(word['text'])
            index += 1
        line['text'] = text
    if result.get('layoutFromOcr'): result['layoutText'] = result['text']
    return result
