export function connectFirstMicrophoneChannel(context, source, destination) {
  const splitter = context.createChannelSplitter(2);
  source.connect(splitter);
  splitter.connect(destination, 0, 0);
  return splitter;
}
