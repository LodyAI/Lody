"""Focused system text-selection acceptance across the three document hosts."""
import os
import runpy
from pathlib import Path

os.environ["LODY_VERIFY_FILE_SELECTION_ONLY"] = "1"
runpy.run_path(str(Path(__file__).with_name("file-preview.py")), run_name="__main__")
