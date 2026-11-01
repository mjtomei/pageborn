"""Transfer supported Xiaomi word corrections onto measured OCR geometry.

The model has no word boxes. Never invent positions, delete unaligned text, or
replace tables/figures from a model description. Preserve omissions for review.
"""
import copy
import difflib
import re
import statistics


def core(word):
    return re.sub(r'[^\w]', '', word, flags=re.UNICODE).casefold()


def correct(extracted, markdown):
    result = copy.deepcopy(extracted)
    words = [word for line in result['text'] for word in line.get('words', [])]
    # Strip formatting, not punctuation. Structured tables/formulas have no
    # trustworthy word-to-pixel mapping; leave those regions to the PDF pipeline.
    prose = re.sub(r'<[^>]*>|\$\$[\s\S]*?\$\$', ' ', markdown)
    target, paragraphs = [], []
    for paragraph, text in enumerate(re.split(r'\n\s*\n', prose)):
        for word in text.split():
            word = word.strip('*`#_')
            if core(word):
                target.append(word); paragraphs.append(paragraph)
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
    supported = {}
    for index, (kind, a, b, c, d) in enumerate(ops):
        if kind == 'equal':
            for i, j in zip(range(a, b), range(c, d)):
                supported[i] = j
                # Case only, preserving printed punctuation and reference marks.
                before = words[i]['text']; after = target[j]
                if before != after and before.casefold() == after.casefold(): replacements[i] = after
        elif kind == 'replace' and b-a == d-c and b-a <= 3:
            # Alternating damaged words and intact articles are common where a
            # pencil line touches print. One matching word on each side still
            # anchors an equal-length local correction within a matching page.
            left = index > 0 and ops[index-1][0] == 'equal'
            right = index+1 < len(ops) and ops[index+1][0] == 'equal'
            right = right or (b == len(source) and d == len(folded) and left
                              and ops[index-1][2]-ops[index-1][1] >= 4)
            if not (left and right): continue
            for i, j in zip(range(a, b), range(c, d)):
                before, after = source[i], folded[j]
                if (any(ch.isalpha() for ch in after) and len(after) <= 40
                        and difflib.SequenceMatcher(None, before, after).ratio() >= .45):
                    replacements[i] = target[j]
                    supported[i] = j
    index = 0
    for line in result['text']:
        text, offset = line['text'], 0
        paragraph_ids = []
        for word in line.get('words', []):
            before = word['text']; at = text.find(before, offset)
            if index in replacements and at >= 0:
                word.setdefault('ocrOriginal', before)
                word.update(text=replacements[index], desktopOcr=True)
                text = text[:at] + word['text'] + text[at+len(before):]
            if index in supported:
                # This is a layout acceptance score, not Xiaomi probability.
                # Retain the raw OCR score for diagnostics and future passes.
                word.setdefault('ocrConfidence', word.get('confidence', 100))
                word.update(desktopMatched=True, confidence=max(85, word.get('confidence', 100)))
                paragraph_ids.append(paragraphs[supported[index]])
            if at >= 0: offset = at + len(word['text'])
            index += 1
        line['text'] = text
        if line.get('words'):
            line.setdefault('ocrConfidence', line.get('confidence', 100))
            line['confidence'] = sum(w.get('confidence', 100) for w in line['words']) / len(line['words'])
            line['desktopUnmatched'] = not any(w.get('desktopMatched') for w in line['words'])
            if len(paragraph_ids) >= len(line['words']) * .65 and len(set(paragraph_ids)) == 1:
                line.setdefault('ocrParagraph', line.get('paragraph'))
                line['paragraph'] = paragraph_ids[0]
                line['desktopParagraph'] = paragraph_ids[0]
    if result.get('layoutFromOcr'): result['layoutText'] = result['text']
    # A connected underline can stretch all word boxes upward into the prior
    # row. Keep their bottom edge, and use neighboring print's typical height
    # only when the two measured rows overlap. No model-created coordinates.
    lines = result['text']
    # A damaged row may not align well enough to inherit a paragraph directly.
    # If both immediately adjacent rows agree, keep that row in their paragraph
    # rather than mixing a Tesseract paragraph ID with Xiaomi's numbering.
    for i, line in enumerate(lines[1:-1], 1):
        previous, following = lines[i-1], lines[i+1]
        if ('desktopParagraph' not in line and 'desktopParagraph' in previous
                and previous['desktopParagraph'] == following.get('desktopParagraph')
                and len(line['text'].split()) >= 4):
            line.setdefault('ocrParagraph', line.get('paragraph'))
            line['paragraph'] = previous['desktopParagraph']
    heights = [l['height'] for l in lines if len(l['text']) >= 30
               and l['width'] > result.get('width', 900) * .35 and 6 <= l['height'] <= 45]
    if len(heights) >= 6:
        height = statistics.median(heights)
        for line in lines:
            if (line['height'] > height * 1.7 and line['height'] < height * 3
                    and line.get('words') and all(w.get('desktopMatched') for w in line['words'])
                    and any(other is not line and other['width'] > line['width'] * .7
                            and abs(other['y'] - line['y']) < height * .6
                            and other['height'] <= height * 1.3 for other in lines)):
                top = line['y'] + line['height'] - height
                for box in [line, *line['words']]:
                    box.setdefault('ocrBounds', {k: box[k] for k in ['x', 'y', 'width', 'height']})
                    low = box['y'] + box['height']
                    box['y'] = max(top, box['y'])
                    box['height'] = max(1, low - box['y'])
    return result
