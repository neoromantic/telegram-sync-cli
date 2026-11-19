const CYRILLIC = /[Ѐ-ӿ]/;
const LATIN = /[a-z]/;

/** Whether a lowercase word has a Cyrillic letter */
export function isCyrillic(word: string) {
  return CYRILLIC.test(word);
}

/** Whether a lowercase word has a Latin letter and no Cyrillic one */
export function isLatin(word: string) {
  return LATIN.test(word) && !CYRILLIC.test(word);
}

const RUSSIAN_ENDINGS: Array<[number, string[]]> = [
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
  for (const [minLength, endings] of RUSSIAN_ENDINGS) {
    if (word.length <= minLength) continue;
    const ending = endings.find((e) => word.endsWith(e));
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

/**
 * The light stem of a lowercase word: Russian case endings stripped for a
 * Cyrillic word (ё read as е), the plural `s` for a Latin one, any other
 * word as it is. Ports of Lucene's RussianLightStemmer and
 * EnglishMinimalStemmer (see NOTICE).
 */
export function lightStem(word: string) {
  if (isCyrillic(word)) return russianLight(word);
  if (isLatin(word)) return englishMinimal(word);
  return word;
}
