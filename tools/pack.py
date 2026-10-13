"""Архив для папки install на накопителе OPKG — в формате GNU tar, как установщик Entware.

Распаковщик npkg в KeeneticOS принимает только числовые поля заголовка, оканчивающиеся NUL (так пишет
GNU tar); архив от bsdtar из macOS (поля с пробелом в конце) он отвергает: «bad size (00000000000)».
Символические ссылки (bin/sh) уходят в архив ссылками.

    python3 tools/pack.py <каталог с bin, etc и share> <архив.tar.gz>
"""
import os
import sys
import tarfile


def as_root(info):
    info.uid = info.gid = 0
    info.uname = info.gname = 'root'
    return info


def main(src, dst):
    with tarfile.open(dst, 'w:gz', format=tarfile.GNU_FORMAT) as tar:
        for top in ('bin', 'etc', 'share'):
            tar.add(os.path.join(src, top), arcname=top, filter=as_root)


if __name__ == '__main__':
    main(*sys.argv[1:])
