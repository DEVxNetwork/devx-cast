import "./index.css";
import { Tabs } from "./components/Tabs";
import { Caster } from "./components/Caster";
import { Presenter } from "./components/Presenter";

export function App() {
  return (
    <div className="app">
      <h1>WebRTC Screen Share</h1>
      <Tabs
        tabs={{
          Caster: <Caster />,
          Presenter: <Presenter />,
        }}
      />
    </div>
  );
}

export default App;
