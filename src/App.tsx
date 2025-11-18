import "./index.css";
import { ChannelListScreen } from "./screens/ChannelListScreen";
import { ChannelPeerScreen } from "./screens/ChannelPeerScreen";
import { ChannelHostScreen } from "./screens/ChannelHostScreen";
import {
  useScreen,
  useSelectedChannelHostKey,
  useHostChannelId,
  useNavigateToHostChannel,
  useNavigateToChannel,
  useNavigateToChannelList,
} from "./store/channelStoreHelpers";

export function App() {
  const screen = useScreen();
  const selectedChannelHostKey = useSelectedChannelHostKey();
  const hostChannelId = useHostChannelId();
  const navigateToHostChannel = useNavigateToHostChannel();
  const navigateToChannel = useNavigateToChannel();
  const navigateToChannelList = useNavigateToChannelList();

  const handleStartChannel = () => {
    navigateToHostChannel(`channel_${Math.random().toString(36).slice(2, 10)}`);
  };

  const handleSelectChannel = (hostKey: string) => {
    navigateToChannel(hostKey);
  };

  const handleBackToList = () => {
    navigateToChannelList();
  };

  if (screen === "host-channel" && hostChannelId) {
    return (
      <ChannelHostScreen
        channelId={hostChannelId}
        onBack={handleBackToList}
      />
    );
  }

  if (screen === "channel" && selectedChannelHostKey) {
    return (
      <ChannelPeerScreen
        hostKey={selectedChannelHostKey}
        onBack={handleBackToList}
      />
    );
  }

  return (
    <ChannelListScreen
      onStartChannel={handleStartChannel}
      onSelectChannel={handleSelectChannel}
    />
  );
}

export default App;

