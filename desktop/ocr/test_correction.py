import unittest
from correction import correct
from guard import pressure


def page(text):
    words = [{'text': word, 'x': i*10, 'y': 5, 'width': 9, 'height': 8} for i, word in enumerate(text.split())]
    lines = [{'text': text, 'words': words, 'x': 0, 'y': 5, 'width': 200, 'height': 8}]
    return {'text': lines, 'layoutText': lines, 'layoutFromOcr': True}


class CorrectionTests(unittest.TestCase):
    def test_supported_words_keep_geometry(self):
        source = page('The modern state 1s the public organization. Its unseen work stays here.')
        result = correct(source, 'The modern state is the public organization. Its unseen work stays here.')
        self.assertIn('state is the public', result['text'][0]['text'])
        self.assertIn('state 1s', source['text'][0]['text'])
        self.assertEqual(result['text'][0]['words'][3]['x'], source['text'][0]['words'][3]['x'])
        self.assertEqual(result['layoutText'], result['text'])

    def test_missing_folios_and_unrelated_responses_do_not_delete_print(self):
        source = page('CONTENTS Chapter One 3 Chapter Two 37 Chapter Three 75')
        self.assertEqual(source['text'][0]['text'], correct(source, 'CONTENTS Chapter One Chapter Two Chapter Three')['text'][0]['text'])
        self.assertEqual(correct(source, 'An entirely unrelated figure description.'), source)

    def test_underlined_words_are_anchored_even_with_one_intact_word_between_them(self):
        source = page('The part of the body that ciTerfains the iders and the part that performs acts.')
        source['text'][0]['confidence'] = 52
        for word in source['text'][0]['words']: word['confidence'] = 22
        result = correct(source, 'The part of the body that entertains the ideas and the part that performs acts.')
        self.assertIn('that entertains the ideas', result['text'][0]['text'])
        self.assertGreaterEqual(result['text'][0]['confidence'], 85)
        self.assertEqual(result['text'][0]['ocrConfidence'], 52)
        self.assertEqual(result['text'][0]['words'][6]['ocrConfidence'], 22)
        self.assertEqual(result['text'][0]['words'][6]['x'], source['text'][0]['words'][6]['x'])

    def test_model_agreement_does_not_delete_unrecognized_annotations(self):
        source = page('A normal printed sentence has several matching words. Be easn TN A second printed sentence remains here.')
        result = correct(source, 'A normal printed sentence has several matching words. A second printed sentence remains here.')
        self.assertIn('Be easn TN', result['text'][0]['text'])
        self.assertFalse(result['text'][0]['words'][8].get('desktopMatched', False))

    def test_overlapping_tall_row_is_bounded_by_neighboring_print(self):
        lines = []
        for i in range(8):
            line = page(f'This is printed row number {i} with enough text.')['text'][0]
            line.update(x=30, y=100+i*30, width=700, height=20, paragraph=i)
            for word in line['words']: word.update(y=line['y'], height=20)
            lines.append(line)
        lines[4]['y'] = lines[3]['y']; lines[4]['height'] = 50
        for word in lines[4]['words']: word.update(y=lines[4]['y'], height=50)
        source = {'width': 900, 'text': lines, 'layoutFromOcr': True}
        markdown = ' '.join(line['text'] for line in lines)
        result = correct(source, markdown)
        self.assertEqual(result['text'][4]['y'], 220)
        self.assertEqual(result['text'][4]['height'], 20)
        self.assertEqual(result['text'][4]['ocrBounds']['y'], 190)
        self.assertEqual({line['paragraph'] for line in result['text']}, {0})
        self.assertEqual(lines[4]['y'], 190)

    def test_memory_guard_precedes_eighty_percent_and_keeps_physical_headroom(self):
        self.assertFalse(pressure({'used_fraction': .70, 'free_bytes': 25*1024**3}))
        self.assertTrue(pressure({'used_fraction': .77, 'free_bytes': 25*1024**3}))
        self.assertTrue(pressure({'used_fraction': .60, 'free_bytes': 5*1024**3}))


if __name__ == '__main__': unittest.main()
