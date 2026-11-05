"""JSON Patch (RFC 6902): see SPEC.md."""


class PatchError(Exception):
    pass


def apply_patch(doc, patch):
    raise NotImplementedError
