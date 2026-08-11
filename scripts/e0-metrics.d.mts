export interface ChannelHeadSeqMap {
  [channelId: string]: number | null;
}

export interface HeadSeqLookup {
  found: boolean;
  headSeq: number | null;
  fieldSet: string[];
}

export function parseChannelList(json: string): ChannelHeadSeqMap;
export function headSeqFor(channels: ChannelHeadSeqMap, channelId: string): HeadSeqLookup;
export function sumHeadSeqs(channels: ChannelHeadSeqMap): number;
