import EnglishStemmer from "./snowball/english-stemmer.js";
import RussianStemmer from "./snowball/russian-stemmer.js";
import { isCyrillic, isLatin } from "../src/utils/word-stems";

/** A stemmer of one lowercase word */
export type Stemmer = (word: string) => string;

/** Words as FTS5's unicode61 splits them: runs of letters, digits, marks and private-use characters, lowercased */
export function tokens(text: string) {
  return text.toLowerCase().match(/[\p{L}\p{N}\p{M}\p{Co}]+/gu) ?? [];
}

const russian = new RussianStemmer();
const english = new EnglishStemmer();

/** Snowball 3.2.0: Russian for Cyrillic words, English (Porter2) for Latin words */
export const snowball: Stemmer = (word) => {
  if (isCyrillic(word)) return russian.stemWord(word);
  if (isLatin(word)) return english.stemWord(word);
  return word;
};

/** The text as the stems of its words, one for each word, so positions and phrases stay */
export function stemText(text: string, stem: Stemmer) {
  return tokens(text).map(stem).join(" ");
}
