import EnglishStemmer from "./snowball/english-stemmer.js";
import RussianStemmer from "./snowball/russian-stemmer.js";

/** A stemmer of one lowercase word */
export type Stemmer = (word: string) => string;

const CYRILLIC = /[Ѐ-ӿ]/;
const LATIN = /[a-z]/;

/** Words as FTS5's unicode61 splits them: runs of letters, digits, marks and private-use characters, lowercased */
export function tokens(text: string) {
  return text.toLowerCase().match(/[\p{L}\p{N}\p{M}\p{Co}]+/gu) ?? [];
}

export function isCyrillic(word: string) {
  return CYRILLIC.test(word);
}

export function isLatin(word: string) {
  return LATIN.test(word) && !CYRILLIC.test(word);
}

const russian = new RussianStemmer();
const english = new EnglishStemmer();

/** Snowball 3.2.0: Russian for Cyrillic words, English (Porter2) for Latin words */
export const snowball: Stemmer = (word) => {
  if (isCyrillic(word)) return russian.stemWord(word);
  if (isLatin(word)) return english.stemWord(word);
  return word;
};

const RU_LIGHT_ENDINGS: Array<[number, string[]]> = [
  [6, ["иями", "оями"]],
  [
    5,
    [
      "иям",
      "иях",
      "оях",
      "ями",
      "оям",
      "оьв",
      "ами",
      "его",
      "ему",
      "ери",
      "ими",
      "ого",
      "ому",
      "ыми",
      "оев",
    ],
  ],
  [
    4,
    [
      "ая",
      "яя",
      "ях",
      "юю",
      "ах",
      "ею",
      "их",
      "ия",
      "ию",
      "ьв",
      "ою",
      "ую",
      "ям",
      "ых",
      "ея",
      "ам",
      "ем",
      "ей",
      "ём",
      "ев",
      "ий",
      "им",
      "ое",
      "ой",
      "ом",
      "ов",
      "ые",
      "ый",
      "ым",
      "ми",
    ],
  ],
];

function russianLight(input: string) {
  let word = input.replaceAll("ё", "е");
  let cut = false;
  for (const [minLength, endings] of RU_LIGHT_ENDINGS) {
    if (word.length <= minLength) continue;
    const ending = endings.find((e) => word.endsWith(e.replaceAll("ё", "е")));
    if (ending) {
      word = word.slice(0, -ending.length);
      cut = true;
      break;
    }
  }
  if (!cut && word.length > 3 && "аеиоуйыяь".includes(word.at(-1) ?? "")) word = word.slice(0, -1);
  if (word.length > 3) {
    const last = word.at(-1);
    if (last === "ь" || last === "и") return word.slice(0, -1);
    if (last === "н" && word.at(-2) === "н") return word.slice(0, -1);
  }
  return word;
}

function englishMinimal(word: string) {
  const n = word.length;
  if (n < 3 || word[n - 1] !== "s") return word;
  const before = word[n - 2];
  if (before === "u" || before === "s") return word;
  if (before === "e") {
    if (n > 3 && word[n - 3] === "i" && word[n - 4] !== "a" && word[n - 4] !== "e") {
      return `${word.slice(0, n - 3)}y`;
    }
    if ("iaoe".includes(word[n - 3] ?? "")) return word;
  }
  return word.slice(0, -1);
}

export const light: Stemmer = (word) => {
  if (isCyrillic(word)) return russianLight(word);
  if (isLatin(word)) return englishMinimal(word);
  return word;
};

/** The text as the stems of its words, one for each word, so positions and phrases stay */
export function stemText(text: string, stem: Stemmer) {
  return tokens(text).map(stem).join(" ");
}
