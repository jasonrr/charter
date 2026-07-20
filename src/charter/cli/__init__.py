"""Charter CLI entry point."""
import sys

from charter.cli import keys, mint_google_token


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    if not argv:
        print("charter — governed verb API for AI agents")
        print()
        print("Commands:")
        print("  charter keys <subcommand>     Key management (list/add/rotate/revoke/mint)")
        print("  charter mint-google-token     Mint a Google refresh token")
        print()
        sys.exit(0)

    cmd = argv[0]
    if cmd == "keys":
        keys.main(argv)
    elif cmd == "mint-google-token":
        mint_google_token.main(argv[1:])
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
