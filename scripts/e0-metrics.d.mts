export interface ChannelEntry {
  headSeq: number | null;
  fieldSet: string[];
}

export interface ChannelHeadSeqMap {
  [channelId: string]: ChannelEntry;
}

export interface HeadSeqLookup {
  found: boolean;
  headSeq: number | null;
  fieldSet: string[] | null;
}

export function parseChannelList(json: string): ChannelHeadSeqMap;
export function headSeqFor(channels: ChannelHeadSeqMap, channelId: string): HeadSeqLookup;
export function sumHeadSeqs(channels: ChannelHeadSeqMap): number;
export function listChannels(baseUrl: string, token: string): Promise<ChannelHeadSeqMap>;
