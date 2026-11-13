import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).parents[1] / 'scripts/oci-library.py')
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class Confessions(unittest.TestCase):
    def document(self):
        return {'format': 'lamplighter-confessions@1', 'works': [{'id': 'faith', 'name': 'Test statement', 'short': 'Test', 'source': 'Synthetic source',
                'chapters': [{'n': 1, 'title': 'Faith', 'paragraphs': [{'n': 1, 'body': ['Faith.', ['a', ['John.3.16']], {'label': 'John 3:16', 'refs': ['John.3.16']}]}]}]}]}

    def test_supported_document_preserves_text_and_proofs(self):
        document = self.document()
        before = copy.deepcopy(document)
        publisher.check_confessions(document, 'faith')
        self.assertEqual(document, before)
        self.assertEqual(publisher.SHAREABLE[document['format']], 'confession')

    def test_malformed_or_mismatched_documents_are_refused(self):
        mutations = [lambda d: d.update(format='other'), lambda d: d.update(works=[]),
                     lambda d: d['works'][0].update(id='other'), lambda d: d['works'][0].update(chapters=[]),
                     lambda d: d['works'][0]['chapters'][0]['paragraphs'][0].update(body=[None]),
                     lambda d: d['works'][0]['chapters'][0]['paragraphs'][0].update(n=True),
                     lambda d: d['works'][0]['chapters'][0]['paragraphs'][0].update(body=[['a', []]]),
                     lambda d: d['works'][0]['chapters'].append(copy.deepcopy(d['works'][0]['chapters'][0]))]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                document = self.document()
                mutate(document)
                with self.assertRaises(SystemExit):
                    publisher.check_confessions(document, 'faith')


if __name__ == '__main__':
    unittest.main()
