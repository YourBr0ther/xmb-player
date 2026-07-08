# session/Dockerfile
# game-session: RetroArch + Selkies-GStreamer WebRTC streaming, GPU via
# VirtualGL EGL inside Xvfb. Adapted from the Selkies v1.6.2 example
# container (MPL-2.0), trimmed to an appliance: no desktop environment.
FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC LANG=en_US.UTF-8 LANGUAGE=en_US:en LC_ALL=en_US.UTF-8

# --- System + Selkies/GStreamer runtime dependencies ---
RUN apt-get update && apt-get install --no-install-recommends -y \
        apt-utils ca-certificates curl gnupg jq locales software-properties-common tzdata unzip \
        ssl-cert dbus-user-session dbus-x11 \
        build-essential python3-pip python3-dev python3-gi python3-setuptools python3-wheel \
        libgcrypt20 libgirepository-1.0-1 glib-networking libglib2.0-0 libgudev-1.0-0 \
        alsa-utils libpulse0 pulseaudio libopus0 libvpx-dev x264 x265 \
        libdrm2 libegl1 libgl1 libopengl0 libgles1 libgles2 libglvnd0 libglx0 xcvt libopenh264-dev \
        wmctrl xsel xdotool x11-utils x11-xkb-utils x11-xserver-utils xserver-xorg-core xvfb \
        libx11-xcb1 libxcb-dri3-0 libxdamage1 libxfixes3 libxv1 libxtst6 libxext6 \
        mesa-utils mesa-va-drivers libva2 vainfo vdpau-driver-all libvdpau-va-gl1 \
        supervisor nginx apache2-utils netcat-openbsd coturn dnsutils \
    && locale-gen en_US.UTF-8 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# --- NVIDIA library paths + EGL vendor config (driver mounts at runtime) ---
RUN echo "/usr/local/nvidia/lib" >> /etc/ld.so.conf.d/nvidia.conf && \
    echo "/usr/local/nvidia/lib64" >> /etc/ld.so.conf.d/nvidia.conf && \
    mkdir -pm755 /usr/share/glvnd/egl_vendor.d && \
    printf '{\n  "file_format_version" : "1.0.0",\n  "ICD": {\n    "library_path": "libEGL_nvidia.so.0"\n  }\n}\n' \
      > /usr/share/glvnd/egl_vendor.d/10_nvidia.json
ENV PATH="/usr/local/nvidia/bin:${PATH}"
ENV LD_LIBRARY_PATH="/usr/local/nvidia/lib:/usr/local/nvidia/lib64"
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=all
ENV __GL_SYNC_TO_VBLANK=0

# --- VirtualGL 3.1.4 (route OpenGL to the GPU via EGL inside Xvfb) ---
ENV VGL_DISPLAY=egl
RUN cd /tmp && \
    curl -fsSL -O https://github.com/VirtualGL/virtualgl/releases/download/3.1.4/virtualgl_3.1.4_amd64.deb && \
    apt-get update && apt-get install -y --no-install-recommends ./virtualgl_3.1.4_amd64.deb && \
    rm -f virtualgl_3.1.4_amd64.deb && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# --- Selkies-GStreamer v1.6.2 (pinned release artifacts) ---
RUN cd /opt && \
    curl -fsSL https://github.com/selkies-project/selkies/releases/download/v1.6.2/gstreamer-selkies_gpl_v1.6.2_ubuntu22.04_amd64.tar.gz | tar -xzf - && \
    mkdir -p /tmp/gst-web-extract && \
    curl -fsSL https://github.com/selkies-project/selkies/releases/download/v1.6.2/selkies-gstreamer-web_v1.6.2.tar.gz | tar -xzf - -C /tmp/gst-web-extract && \
    mkdir -p /opt/gst-web && \
    cp -a /tmp/gst-web-extract/*/. /opt/gst-web/ 2>/dev/null || cp -a /tmp/gst-web-extract/. /opt/gst-web/ && \
    rm -rf /tmp/gst-web-extract && \
    test -f /opt/gst-web/index.html && \
    curl -fsSL -o /tmp/selkies_gstreamer-1.6.2-py3-none-any.whl https://github.com/selkies-project/selkies/releases/download/v1.6.2/selkies_gstreamer-1.6.2-py3-none-any.whl && \
    pip3 install --no-cache-dir /tmp/selkies_gstreamer-1.6.2-py3-none-any.whl && rm -f /tmp/selkies_gstreamer-1.6.2-py3-none-any.whl && \
    curl -fsSL -o /tmp/js-interposer.deb https://github.com/selkies-project/selkies/releases/download/v1.6.2/selkies-js-interposer_v1.6.2_ubuntu22.04_amd64.deb && \
    apt-get update && apt-get install -y --no-install-recommends /tmp/js-interposer.deb && \
    rm -f /tmp/js-interposer.deb && apt-get clean && rm -rf /var/lib/apt/lists/*

# --- RetroArch (libretro stable PPA) + cores (libretro buildbot) ---
RUN add-apt-repository -y ppa:libretro/stable && \
    apt-get update && apt-get install --no-install-recommends -y retroarch && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/cores && cd /opt/cores && \
    for core in mgba ppsspp; do \
      curl -fsSL -O "https://buildbot.libretro.com/nightly/linux/x86_64/latest/${core}_libretro.so.zip" && \
      unzip -o "${core}_libretro.so.zip" && rm -f "${core}_libretro.so.zip"; \
    done && \
    mkdir -p /opt/retroarch/system && cd /opt/retroarch/system && \
    curl -fsSL -O https://buildbot.libretro.com/assets/system/PPSSPP.zip && \
    unzip -oq PPSSPP.zip && rm -f PPSSPP.zip

# --- Non-root user; nginx/logs writable ---
RUN groupadd -g 1000 psp && useradd -ms /bin/bash -u 1000 -g 1000 psp && \
    usermod -aG audio,video,input psp && \
    mkdir -p /roms /saves /states /var/log/supervisor && \
    chown -R psp:psp /roms /saves /states /opt/retroarch /opt/gst-web /var/log/supervisor && \
    chown -R psp:psp /var/lib/nginx /var/log/nginx /etc/nginx/sites-available && \
    sed -i 's/^user www-data;/user psp;/' /etc/nginx/nginx.conf

# --- Our components ---
COPY supervisor/supervisor.py /opt/supervisor/supervisor.py
COPY retroarch.cfg /opt/retroarch/retroarch.cfg
COPY pulse-daemon.conf /etc/pulse/daemon.conf.d/99-stream.conf
COPY entrypoint.sh /etc/entrypoint.sh
COPY selkies-gstreamer-entrypoint.sh /etc/selkies-gstreamer-entrypoint.sh
COPY supervisord.conf /etc/supervisord.conf
RUN chmod 755 /etc/entrypoint.sh /etc/selkies-gstreamer-entrypoint.sh && \
    chown psp:psp /opt/retroarch/retroarch.cfg

ENV DISPLAY=:20
ENV XDG_RUNTIME_DIR=/tmp/runtime-psp
ENV PULSE_RUNTIME_PATH=/tmp/runtime-psp/pulse
ENV PULSE_SERVER=unix:/tmp/runtime-psp/pulse/native
ENV GST_DEBUG="*:2"
ENV SELKIES_ENCODER=nvh264enc
ENV SELKIES_ENABLE_RESIZE=false
ENV CORES_DIR=/opt/cores
ENV RETROARCH_CONFIG=/opt/retroarch/retroarch.cfg

EXPOSE 8080 9090

ENTRYPOINT ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf"]
