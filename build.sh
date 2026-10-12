#!/bin/bash
# Сборка hostsgen-ui: программа-помощник под три процессора Keenetic и архив для установки
# через веб-интерфейс (папка install на накопителе OPKG).
#   dist/install/hostsgen-ui.tar.gz — пути внутри относительно /opt, как у установщика Entware
# Нужны: node (тесты addon.js), zig (кросс-компиляция C со статическим musl).
set -euo pipefail
cd "$(dirname "$0")"

node --test tests/*.test.js

PKG=dist/pkg
rm -rf dist
mkdir -p "$PKG/etc/init.d" "$PKG/share/hostsgen-ui/bin" dist/install

# mipsel — MT7621 (Giga KN-1010/1011 и др.), mips — EcoNet (DSL-модели), aarch64 — MT7981/MT7622/MT7988.
# На MIPS у Keenetic нет FPU: собираем с программной плавающей точкой.
for build in mipsel:mipsel-linux-musleabi:-msoft-float mips:mips-linux-musleabi:-msoft-float aarch64:aarch64-linux-musl:; do
	IFS=: read -r arch target extra <<<"$build"
	zig cc -target "$target" $extra -Os -s -static -Wall -Wextra -Werror \
		-o "$PKG/share/hostsgen-ui/bin/hostsgen-ui.$arch" helper/hostsgen-ui.c
done

cp web/addon.js "$PKG/share/hostsgen-ui/"
cp router/S99hostsgen-ui "$PKG/etc/init.d/"
cp router/initrc "$PKG/etc/"
chmod 755 "$PKG/etc/initrc" "$PKG/etc/init.d/S99hostsgen-ui" "$PKG"/share/hostsgen-ui/bin/*
chmod 644 "$PKG/share/hostsgen-ui/addon.js"

# не tar из macOS: его заголовки распаковщик прошивки отвергает (подробности в tools/pack.py)
python3 -I tools/pack.py "$PKG" dist/install/hostsgen-ui.tar.gz

ls -l "$PKG/share/hostsgen-ui/bin" dist/install/hostsgen-ui.tar.gz
