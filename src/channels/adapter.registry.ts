import { BaseChannelAdapter } from "./base.adapter";
import { FacebookAdapter } from "./facebook.adapter";
import { InstagramAdapter } from "./instagram.adapter";
import { LineAdapter } from "./line.adapter";
import { TelegramAdapter } from "./telegram.adapter";
import { TikTokAdapter } from "./tiktok.adapter";
import { CanonicalChannel } from "./types";
import { ViberAdapter } from "./viber.adapter";
import { WebsiteAdapter } from "./website.adapter";

export class AdapterRegistry {
  private readonly adapters = new Map<CanonicalChannel, BaseChannelAdapter>();

  constructor() {
    const instances = [
      new FacebookAdapter(),
      new InstagramAdapter(),
      new TelegramAdapter(),
      new ViberAdapter(),
      new TikTokAdapter(),
      new LineAdapter(),
      new WebsiteAdapter(),
    ];

    for (const adapter of instances) {
      this.adapters.set(adapter.channel, adapter);
    }
  }

  get(channel: CanonicalChannel) {
    const adapter = this.adapters.get(channel);
    if (!adapter) {
      throw new Error(`Adapter not registered for channel ${channel}`);
    }

    return adapter;
  }
}

export const adapterRegistry = new AdapterRegistry();
