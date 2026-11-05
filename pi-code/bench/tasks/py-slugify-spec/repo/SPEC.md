# slugify(text, max_len=60)

Turns a title into a URL slug.

1. Letters with accents become their plain ASCII letter (é → e, Ø stays out: characters with no
   ASCII form are dropped). Use Unicode NFKD decomposition and drop what isn't ASCII.
2. Lowercase.
3. Every run of characters that aren't a-z or 0-9 becomes a single `-`.
4. No `-` at the start or end.
5. If longer than max_len, cut it to at most max_len characters, at a `-` if there is one within
   the limit (so words aren't split), else hard at max_len. Never end with `-` after cutting.
6. If nothing is left, return `n-a`.
