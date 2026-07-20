class VerbError(Exception):
    """A verb-level failure the dispatcher maps to an HTTP status + audited result."""
    def __init__(self, status, code, detail=None):
        super().__init__(code)
        self.status, self.code, self.detail = status, code, detail
