#!/usr/bin/env python3
import os
from pathlib import Path
import sys

COMPILE_MARK = ' in Sources */'
RESOURCE_MARK = ' in Resources */'

TARGETS = (
    {
        'name': 'Lody',
        'root': Path('apps/ios/App'),
        'compile': {'.swift', '.m', '.metal'},
        'resources': set(),
    },
    {
        'name': 'Extensions',
        'root': Path('apps/ios/Extensions'),
        'compile': {'.swift', '.m', '.metal'},
        'resources': set(),
    },
)


def repo_root() -> Path:
    start = Path(os.environ.get('SRCROOT') or os.getcwd()).resolve()
    for candidate in [start, *start.parents]:
        if (candidate / 'pnpm-workspace.yaml').is_file():
            return candidate
    sys.stderr.write('Could not find the lody-ios workspace root.\n')
    sys.exit(2)


def project_path(root: Path) -> Path:
    env = os.environ.get('PROJECT_FILE_PATH')
    if env:
        path = Path(env)
        return path / 'project.pbxproj' if path.suffix == '.xcodeproj' else path
    return root / 'apps/ios/Lody.xcodeproj/project.pbxproj'


def sources(directory: Path, suffixes: set[str]) -> list[Path]:
    if not suffixes:
        return []
    return sorted(
        path
        for path in directory.rglob('*')
        if (path.is_file() or path.is_symlink()) and path.suffix in suffixes
    )


def linked(project: str, filename: str, mark: str) -> bool:
    return f'{filename}{mark}' in project


def main() -> int:
    root = repo_root()
    project_file = project_path(root)
    if not project_file.is_file():
        return 0
    project = project_file.read_text()
    missing: list[str] = []
    for target in TARGETS:
        directory = root / target['root']
        if not directory.is_dir():
            missing.append(f"{target['name']}: source directory {target['root']} is missing")
            continue
        for path in sources(directory, target['compile']):
            if not path.is_file():
                missing.append(f"{target['name']} broken source link: {path.relative_to(directory)}")
            elif not linked(project, path.name, COMPILE_MARK):
                missing.append(f"{target['name']} compile: {path.relative_to(directory)}")
        for path in sources(directory, target['resources']):
            if not linked(project, path.name, RESOURCE_MARK):
                missing.append(f"{target['name']} resources: {path.relative_to(directory)}")
    if not missing:
        return 0
    sys.stderr.write(
        'Native sources are missing from Lody.xcodeproj. Run: pnpm prebuild\n'
    )
    for item in missing:
        sys.stderr.write(f'  {item}\n')
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
