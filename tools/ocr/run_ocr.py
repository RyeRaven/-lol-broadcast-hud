"""采集脚本统一入口：run_ocr.py hp|econ [参数...]。

hp_bars / econ_ocr 保持可独立运行；捆绑运行时与托管模式（src/ocr-supervisor.js）
经此入口分发。脚本查找顺序：本目录（捆绑运行时把 hp_bars.py 拷在同目录），
其次是仓库布局的 tools/pixel-bars（系统 Python 兜底时用）。
"""
import os
import sys


def _script_dirs():
    here = os.path.dirname(os.path.abspath(__file__))
    return [here, os.path.normpath(os.path.join(here, "..", "pixel-bars"))]


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("hp", "econ"):
        print("usage: run_ocr.py hp|econ [--port-obs 4455 --port-api 3210 ...]")
        return 2
    for entry in _script_dirs():
        if os.path.isdir(entry) and entry not in sys.path:
            sys.path.insert(0, entry)
    name = sys.argv.pop(1)
    if name == "hp":
        import hp_bars
        hp_bars.main()
    else:
        import econ_ocr
        econ_ocr.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
