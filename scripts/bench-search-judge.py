# /// script
# requires-python = ">=3.10"
# dependencies = ["pymorphy3==2.0.6", "lemminflect==0.2.3"]
# ///
"""The judge of bench-search.ts: the lemmas of each word on stdin, one word per line.

Prints one line per word: word, its lemmas joined by spaces, its first lemma, and 1 when
it is a content word (or 0). Cyrillic words go to pymorphy3, Latin words to LemmInflect;
others are their own lemma. Runs locally; reads nothing but stdin.
"""

import re
import sys

import lemminflect
import pymorphy3

CYRILLIC = re.compile("[Ѐ-ӿ]")
LATIN = re.compile("[a-z]")
FUNCTION_POS = {"PREP", "CONJ", "PRCL", "INTJ", "NPRO"}
EN_ORDER = ("NOUN", "VERB", "ADJ", "ADV")

morph = pymorphy3.MorphAnalyzer()


def norm(lemma: str) -> str:
    return lemma.lower().replace("ё", "е")


def judge(word: str):
    if CYRILLIC.search(word):
        parses = morph.parse(word)
        lemmas = list(dict.fromkeys(norm(p.normal_form) for p in parses))
        top = parses[0]
        content = top.tag.POS is not None and top.tag.POS not in FUNCTION_POS
        return lemmas, top.normal_form, content
    if LATIN.search(word):
        found = lemminflect.getAllLemmas(word)
        if not found:
            return [word], word, False
        ordered = [lemma for pos in EN_ORDER for lemma in found.get(pos, ())]
        lemmas = list(dict.fromkeys(norm(lemma) for lemma in ordered))
        return lemmas, ordered[0], True
    return [word], word, False


out = sys.stdout
for line in sys.stdin:
    word = line.strip()
    if not word:
        continue
    lemmas, top, content = judge(word)
    out.write(f"{word}\t{' '.join(lemmas)}\t{top}\t{1 if content else 0}\n")
