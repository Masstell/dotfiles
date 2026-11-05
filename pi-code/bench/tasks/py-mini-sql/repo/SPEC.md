# query(columns, rows, sql)

Runs one SQL `SELECT` over a single table and returns the result as a list of tuples. `columns` is the
list of column names; `rows` is a list of tuples of the same length. Values are `int`, `str` or `None`
(SQL NULL). Within a column, all non-NULL values have the same type. Don't use `sqlite3` or any other
database library. Invalid queries raise `SqlError`. The results must be exactly what SQLite returns for
the same table and query (AVG as a float).

## Grammar

Keywords are case-insensitive; so are column names. The table is always called `t`.

```
SELECT select_list FROM t [WHERE cond] [GROUP BY col {, col}] [ORDER BY order_item {, order_item}]
       [LIMIT n [OFFSET m]]
select_list := "*" | item {, item}
item        := col | COUNT(*) | COUNT(col) | SUM(col) | MIN(col) | MAX(col) | AVG(col)
order_item  := (item | n) [ASC | DESC]          -- n: 1-based output column position
cond        := cond OR cond | cond AND cond | NOT cond | ( cond )
             | operand op operand | operand IS NULL | operand IS NOT NULL
op          := = | != | <> | < | <= | > | >=
operand     := col | integer (optionally with a leading -) | 'string' ('' inside is one ') | NULL
```

Precedence: `NOT` binds tightest, then `AND`, then `OR`. `n` and `m` are non-negative integers.
Queries never compare a number with a string.

## Meaning

- `*` selects every column, in table order.
- WHERE uses SQL's three-valued logic: a comparison with NULL is unknown; `NOT unknown` is unknown;
  `x AND y` is false if either is false, else unknown if either is unknown; `x OR y` is true if either
  is true, else unknown if either is unknown. Only rows where the condition is true are kept.
  `IS NULL` / `IS NOT NULL` are never unknown.
- Strings compare by Unicode code point.
- Aggregates: `COUNT(*)` counts rows; `COUNT(col)` counts non-NULL values; `SUM`, `MIN`, `MAX`
  ignore NULLs and return NULL when there are no non-NULL values; `AVG` is the float mean of the
  non-NULL values, or NULL.
- With aggregates and no GROUP BY, the result is one row, even when no rows match.
- With GROUP BY, there is one result row per distinct combination of the grouped columns' values
  (NULLs group together). Every plain column in the select list must be one of the GROUP BY columns.
  A query with aggregates and no GROUP BY can't select plain columns.
- ORDER BY items refer to the select list: a column or aggregate that appears in it (written the same
  way), or a position among the output columns (with `*`, the table's columns: `SELECT * ... ORDER BY 4`
  sorts by the fourth column). NULLs come first in ascending order and last in descending order. Without
  ORDER BY, row order is up to you.
- `LIMIT n` keeps the first n result rows after ordering; `OFFSET m` skips m rows first.

## Errors (`SqlError`)

Bad syntax; a table other than `t`; an unknown column (anywhere); `SELECT *` with GROUP BY; a plain
column that isn't grouped in a query with aggregates or GROUP BY; `*` in anything but `COUNT(*)`; an
ORDER BY item that isn't in the select list, or a position out of range.
