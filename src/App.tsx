import { useState } from "react";
import "./index.css";
import { ChannelListScreen } from "./screens/ChannelListScreen";
import { ChannelPeerScreen } from "./screens/ChannelPeerScreen";
import { ChannelHostScreen } from "./screens/ChannelHostScreen";

type Screen = "channel-list" | "channel" | "host-channel";

export function App() {
  const [screen, setScreen] = useState<Screen>("channel-list");
  const [selectedChannelHostKey, setSelectedChannelHostKey] = useState<string | null>(null);
  const [hostChannelId, setHostChannelId] = useState<string | null>(null);

  const handleStartChannel = () => {
    setScreen("host-channel");
    setHostChannelId(`channel_${Math.random().toString(36).slice(2, 10)}`);
  };

  const handleSelectChannel = (hostKey: string) => {
    setSelectedChannelHostKey(hostKey);
    setScreen("channel");
  };

  const handleBackToList = () => {
    setScreen("channel-list");
    setSelectedChannelHostKey(null);
    setHostChannelId(null);
  };

  if (screen === "host-channel") {
    return (
      <ChannelHostScreen
        channelId={hostChannelId!}
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

