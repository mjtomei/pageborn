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
        self.assertEqual(source, correct(source, 'CONTENTS Chapter One Chapter Two Chapter Three'))
        self.assertEqual(correct(source, 'An entirely unrelated figure description.'), source)

    def test_memory_guard_precedes_eighty_percent_and_keeps_physical_headroom(self):
        self.assertFalse(pressure({'used_fraction': .70, 'free_bytes': 25*1024**3}))
        self.assertTrue(pressure({'used_fraction': .77, 'free_bytes': 25*1024**3}))
        self.assertTrue(pressure({'used_fraction': .60, 'free_bytes': 5*1024**3}))


if __name__ == '__main__': unittest.main()
