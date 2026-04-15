"""Entry point for running the MCP server: python -m src.mcp"""
from .server import main
import asyncio

if __name__ == "__main__":
    asyncio.run(main())
