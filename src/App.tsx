import "./index.css";
import { Tabs } from "./components/Tabs";
import { Streamer } from "./components/Streamer";
import { Presenter } from "./components/Presenter";

export function App() {
  return (
    <div className="app">
      <h1>WebRTC Screen Share</h1>
      <Tabs
        tabs={{
          Streamer: <Streamer />,
          Presenter: <Presenter />,
        }}
      />
    </div>
  );
}

export default App;
