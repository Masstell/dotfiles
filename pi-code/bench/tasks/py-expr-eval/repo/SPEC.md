# evaluate(src, env=None)

Evaluates an expression string and returns an `int` or a `bool`. `env` maps variable names to values
(ints or bools). Errors are `ParseError` (bad syntax; `.pos` is a 0-based index into `src`) or `EvalError`
(a valid expression that can't be evaluated). Both subclass `ExprError`. Nothing else may be raised.

## Tokens

The whole input is split into tokens first, left to right, skipping spaces, tabs and newlines:

- integer: one or more ASCII digits (`007` is 7). No signs, underscores, decimals or exponents.
- name: an ASCII letter or `_`, then ASCII letters, digits or `_`. `and`, `or`, `not` are keywords, not names.
- operators, longest match first: `**` `//` `<=` `>=` `==` `!=` `+` `-` `*` `%` `<` `>` `(` `)` `,`

Any other character is a `ParseError` at its position, even if the text before it is also invalid.

## Grammar, lowest precedence first

```
expr    := and_ ( "or" and_ )*
and_    := not_ ( "and" not_ )*
not_    := "not" not_ | cmp
cmp     := sum ( ("<"|"<="|">"|">="|"=="|"!=") sum )*
sum     := term ( ("+"|"-") term )*
term    := unary ( ("*"|"//"|"%") unary )*
unary   := ("+"|"-") unary | power
power   := atom ( "**" unary )?
atom    := INT | NAME | NAME "(" [ expr ( "," expr )* ] ")" | "(" expr ")"
```

So `**` is right-associative and binds tighter than a unary minus on its left (`-2**2` is -4,
`2**3**2` is 512), and its right side may itself have a sign (`2**-1` parses). Binary `+ - * // %` are
left-associative. A name directly followed by `(` is a call.

After a complete `expr` the input must end. A `ParseError`'s `.pos` is the start index of the token where
parsing failed (for the end of input, `len(src)`); for a bad character, its index.

## Evaluation

Ints and bools behave as in Python (a bool in arithmetic counts as 1 or 0).

- Operands are evaluated left to right; an error stops evaluation.
- `+ - *` and unary `+ -`: as in Python.
- `//` and `%`: Python's floor division and modulo. A zero right side is `EvalError` ("division by zero").
- `**`: a negative exponent is `EvalError`; an exponent above 10000 is `EvalError`. Otherwise as in Python.
- Comparisons chain as in Python: `a < b < c` means `a < b and b < c` with `b` evaluated once, and
  evaluation stops at the first false comparison (later operands are not evaluated). The result is a bool.
- `and`, `or` short-circuit (the right side is evaluated only if needed) and return `True` or `False`.
  `not` returns `True` or `False`.
- A name not in `env`: `EvalError`.
- Calls: `min(...)` and `max(...)` take one or more arguments and return one of them, as Python's do;
  `abs(x)` takes exactly one. Any other function, or the wrong number of arguments: `EvalError`.
  Arguments are evaluated left to right before the call.
