const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Desklet = imports.ui.desklet;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Cogl = imports.gi.Cogl;
const Settings = imports.ui.settings;
const Soup = imports.gi.Soup;
const Cinnamon = imports.gi.Cinnamon;

let session;
if (Soup.get_major_version() === 2) {
  session = new Soup.SessionAsync();
  Soup.Session.prototype.add_feature.call(
    session,
    new Soup.ProxyResolverDefault(),
  );
} else {
  session = new Soup.Session();
}

function GoComicsDesklet(metadata, deskletID) {
  this._init(metadata, deskletID);
}

GoComicsDesklet.prototype = {
  __proto__: Desklet.Desklet.prototype,

  _init(metadata, deskletID) {
    Desklet.Desklet.prototype._init.call(this, metadata, deskletID);

    this.settings = new Settings.DeskletSettings(
      this,
      metadata.uuid,
      deskletID,
    );

    this.settings.bind("comicName", "comicName", this.refresh.bind(this));
    this.settings.bind("mode", "mode", this.refresh.bind(this));
    this.settings.bind(
      "customImageUrl",
      "customImageUrl",
      this.refresh.bind(this),
    );
    this.settings.bind("maxWidth", "maxWidth", this.refresh.bind(this));

    this.image = new Clutter.Image();

    //frame actor that holds the image content
    this.imageFrame = new Clutter.Actor({
      reactive: false,
      x_align: Clutter.ActorAlign.CENTER, //prevents awkward side/empty space
      y_align: Clutter.ActorAlign.START,
    });
    this.imageFrame.set_content(this.image);

    this.label = new St.Label({
      text: "",
      style: "padding: 0px; margin: 0px; text-align: center;",
    });

    this.window = new St.BoxLayout({
      vertical: true,
      style: "padding: 0px; margin: 0px;",
      x_expand: false,
      y_expand: false,
    });

    this.window.add_actor(this.imageFrame);
    this.window.add_actor(this.label);

    this.setContent(this.window);

    this.savePath = GLib.build_filenamev([
      GLib.get_home_dir(),
      ".cache",
      "gocomics-desklet",
    ]);
    try {
      Gio.file_new_for_path(this.savePath).make_directory_with_parents(null);
    } catch (e) {
      // ignore
    }

    this.refresh();
  },

  getYesterdayUrl(comic) {
    let d = GLib.DateTime.new_now_local().add_days(-1);
    return `https://www.gocomics.com/${comic}/${d.format("%Y")}/${d.format("%m")}/${d.format("%d")}`;
  },

  isDirectImageUrl(url) {
    return (
      /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(url) ||
      /https:\/\/(featureassets\.gocomics\.com|assets\.amuniversal\.com)\//i.test(
        url,
      )
    );
  },

  _setStatus(text) {
    //shows status text only when non-empty; otherwise hides label so it doesn't reserve space.
    if (text && text.trim().length > 0) {
      this.label.set_text(text);
      this.label.show();
    } else {
      this.label.set_text("");
      this.label.hide();
    }
  },

  download(url, dest, cb) {
    let file = Gio.file_new_for_path(dest);
    let stream = new Gio.DataOutputStream({
      base_stream: file.replace(null, false, Gio.FileCreateFlags.NONE, null),
    });

    let msg = Soup.Message.new("GET", url);

    msg.request_headers.append(
      "User-Agent",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    );
    msg.request_headers.append("Referer", "https://www.gocomics.com/");
    msg.request_headers.append(
      "Accept",
      "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
    );

    const fail = (why) => {
      try {
        stream.close(null);
      } catch (e) {}
      if (why) global.logError(why);
      cb(false);
    };

    if (Soup.get_major_version() === 2) {
      session.queue_message(msg, () => {
        if (msg.status_code !== Soup.KnownStatusCode.OK) {
          return fail(`HTTP ${msg.status_code} for ${url}`);
        }
        try {
          stream.write_bytes(msg.response_body.flatten().get_as_bytes(), null);
          stream.close(null);
          cb(true);
        } catch (e) {
          global.logError(e);
          fail();
        }
      });
    } else {
      session.send_and_read_async(
        msg,
        Soup.MessagePriority.NORMAL,
        null,
        (_, r) => {
          if (msg.status_code !== Soup.Status.OK) {
            return fail(`HTTP ${msg.status_code} for ${url}`);
          }
          try {
            stream.write_bytes(session.send_and_read_finish(r), null);
            stream.close(null);
            cb(true);
          } catch (e) {
            global.logError(e);
            fail();
          }
        },
      );
    }
  },

  loadImage(path) {
    let pixbuf;
    try {
      pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
    } catch (e) {
      global.logError(e);
      this._setStatus("Failed to read image");
      return;
    }

    // ✅ clamp maxWidth defensively
    let maxWidth = Number.isFinite(this.maxWidth) ? this.maxWidth : 600;
    maxWidth = Math.max(50, Math.min(3000, maxWidth));

    let srcW = pixbuf.get_width();
    let srcH = pixbuf.get_height();

    if (srcW <= 0 || srcH <= 0) {
      this._setStatus("Invalid image dimensions");
      return;
    }

    let scale = Math.min(1, maxWidth / srcW);
    let width = Math.max(1, Math.round(srcW * scale));
    let height = Math.max(1, Math.round(srcH * scale));

    let scaled = pixbuf;
    if (width !== srcW || height !== srcH) {
      scaled = pixbuf.scale_simple(
        width,
        height,
        GdkPixbuf.InterpType.BILINEAR,
      );
    }

    try {
      this.image.set_data(
        scaled.get_pixels(),
        scaled.get_has_alpha()
          ? Cogl.PixelFormat.RGBA_8888
          : Cogl.PixelFormat.RGB_888,
        width,
        height,
        scaled.get_rowstride(),
      );

      this.imageFrame.set_size(width, height);

      //hide label so it doesn't create a footer-like gap
      this._setStatus("");
    } catch (e) {
      global.logError(e);
      this._setStatus("Failed to render image");
    }
  },

  refresh() {
    this._setStatus("Loading…");

    let mode = this.mode || "daily";
    let imgFile = `${this.savePath}/comic.png`;

    if (mode === "custom") {
      let url = (this.customImageUrl || "").trim();
      this.setHeader("Custom image");

      if (!url) return this._setStatus("No custom image URL set");
      if (!this.isDirectImageUrl(url))
        return this._setStatus("Custom URL must be a direct image link");

      this.download(url, imgFile, (ok) => {
        if (!ok) return this._setStatus("Failed to load image");
        this.loadImage(imgFile);
      });
      return;
    }

    // DAILY MODE
    let comic = (this.comicName || "").trim().toLowerCase();
    if (!comic) {
      this.setHeader("GoComics");
      return this._setStatus("No comic name set");
    }

    this.setHeader(`GoComics: ${comic}`);

    let htmlFile = `${this.savePath}/page.html`;
    this.download(this.getYesterdayUrl(comic), htmlFile, (ok) => {
      if (!ok) return this._setStatus("Comic page not found");

      try {
        let html = Cinnamon.get_file_contents_utf8_sync(htmlFile);

        let match = html.match(/<meta property="og:image" content="([^"]+)"/i);
        let imgUrl = match ? match[1] : null;

        if (!imgUrl) {
          let asset = html.match(
            /https:\/\/featureassets\.gocomics\.com\/assets\/[a-f0-9]+/i,
          );
          if (asset)
            imgUrl = asset[0] + "?optimizer=image&width=2400&quality=85";
        }

        if (!imgUrl) throw new Error("No image URL found in HTML");

        this.download(imgUrl, imgFile, (ok2) => {
          if (!ok2) return this._setStatus("Image download failed");
          this.loadImage(imgFile);
        });
      } catch (e) {
        global.logError(e);
        this._setStatus("Comic not found");
      }
    });
  },
};

function main(metadata, deskletID) {
  return new GoComicsDesklet(metadata, deskletID);
}
