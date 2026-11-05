# slugify(text, max_len=60)

Turns a title into a URL slug.

1. Letters with accents become their plain ASCII letter (é → e, Ø stays out: characters with no
   ASCII form are dropped). Use Unicode NFKD decomposition and drop what isn't ASCII.
2. Lowercase.
3. Every run of characters that aren't a-z or 0-9 becomes a single `-`.
4. No `-` at the start or end.
5. If longer than max_len, keep the longest run of whole words that fits in max_len characters
   (`alpha-beta-gamma` with max_len 10 is `alpha-beta`; with 12 it's also `alpha-beta`). If not even
   the first word fits, cut it hard at max_len. Never end with `-`.
6. If nothing is left, return `n-a`.
