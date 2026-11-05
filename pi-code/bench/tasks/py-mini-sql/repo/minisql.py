"""A tiny SQL SELECT engine over one in-memory table (see SPEC.md)."""


class SqlError(Exception):
    pass


def query(columns, rows, sql):
    raise NotImplementedError
