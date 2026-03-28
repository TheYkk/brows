/**
 * BM25 scoring from FTS4 matchinfo('pcnalx') data.
 *
 * matchinfo format 'pcnalx':
 *   p  = number of matchable phrases
 *   c  = number of FTS columns
 *   n  = total rows in FTS table
 *   a  = c values: average tokens per column
 *   l  = c values: tokens in current row per column
 *   x  = p*c*3 values: for each (phrase,col) triple of
 *        (hits_this_row, hits_all_rows, docs_with_hit)
 */

const COLUMN_WEIGHTS = [
  10.0, // title
   5.0, // url
   3.0, // domain
   2.0, // path
   1.5, // meta_description
   1.0, // meta_keywords
   1.0, // og_title
   1.0, // og_description
];

const K1 = 1.2;
const B  = 0.75;

function parseMatchInfo(uint8arr) {
  const view = new DataView(uint8arr.buffer, uint8arr.byteOffset, uint8arr.byteLength);
  const count = uint8arr.byteLength / 4;
  const result = new Array(count);
  for (let i = 0; i < count; i++) {
    result[i] = view.getUint32(i * 4, true);
  }
  return result;
}

function computeBM25(matchinfoRaw, weights) {
  const mi = parseMatchInfo(matchinfoRaw);
  const p = mi[0];
  const c = mi[1];
  const n = mi[2];

  const w = weights || COLUMN_WEIGHTS;

  let offset = 3;
  const avgLengths = [];
  for (let col = 0; col < c; col++) {
    avgLengths.push(mi[offset + col]);
  }
  offset += c;

  const docLengths = [];
  for (let col = 0; col < c; col++) {
    docLengths.push(mi[offset + col]);
  }
  offset += c;

  let score = 0.0;

  for (let phrase = 0; phrase < p; phrase++) {
    for (let col = 0; col < c; col++) {
      const idx = offset + (phrase * c + col) * 3;
      const hitsThisRow = mi[idx];
      const docsWithHit = mi[idx + 2];

      if (hitsThisRow === 0) continue;

      const colWeight = col < w.length ? w[col] : 1.0;
      const avgdl = avgLengths[col] || 1;
      const dl = docLengths[col] || 0;

      const idf = Math.log(((n - docsWithHit + 0.5) / (docsWithHit + 0.5)) + 1.0);
      const tf = (hitsThisRow * (K1 + 1)) / (hitsThisRow + K1 * (1 - B + B * dl / avgdl));

      score += colWeight * idf * tf;
    }
  }

  return score;
}
