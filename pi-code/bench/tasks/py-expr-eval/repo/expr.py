"""Evaluate small expressions (see SPEC.md)."""


class ExprError(Exception):
    pass


class ParseError(ExprError):
    def __init__(self, msg, pos):
        super().__init__(f"{msg} at {pos}")
        self.pos = pos


class EvalError(ExprError):
    pass


def evaluate(src, env=None):
    raise NotImplementedError
