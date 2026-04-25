{pkgs}: {
  deps = [
    pkgs.xorg.libXrandr
    pkgs.xorg.libXfixes
    pkgs.xorg.libXext
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.xorg.libxcb
    pkgs.xorg.libX11
    pkgs.mesa
    pkgs.libGL
    pkgs.libdrm
    pkgs.at-spi2-core
    pkgs.at-spi2-atk
    pkgs.alsa-lib
    pkgs.pango
    pkgs.libxkbcommon
    pkgs.expat
    pkgs.cairo
    pkgs.atk
    pkgs.dbus
    pkgs.cups
    pkgs.nspr
    pkgs.nss
    pkgs.glib
  ];
}
