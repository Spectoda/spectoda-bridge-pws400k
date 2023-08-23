import bodyParser from "body-parser";
import express from "express";
import { spectodaDevice } from "./communication";
import cors from "cors";
import SSE from "express-sse-ts";
import fs from "fs";

const jsonParser = bodyParser.json();
const urlencodedParser = bodyParser.urlencoded({ extended: false });

const app: express.Application = express();
const port: number = Number(process.env.PORT) || 8888;

let connecting = false;
let fwUploading = false;

app.use(jsonParser);
app.use(urlencodedParser);
app.use(cors());

export const sse = new SSE();
export const sseota = new SSE();

fs.writeFileSync("assets/lastboot.txt", new Date().toISOString());

app.get("/events", sse.init);
spectodaDevice.on("emitted_events", (events: SpectodaEvent[]) => {
  for (const event of events) {
    sse.send(JSON.stringify(event));
  }
});

app.get("/local-events", sse.init);
spectodaDevice.on("emitted_local_events", (events: SpectodaEvent[]) => {
  for (const event of events) {
    sse.send(JSON.stringify(event));
  }
});

export const sseconnection = new SSE();
app.get("/connection", sseconnection.init);
spectodaDevice.on("connected", (event: any) => {
  sseconnection.send("connected");
});

spectodaDevice.on("disconnected", (event: any) => {
  sseconnection.send("disconnected");
});

app.get("/ota-progress", sseota.init);
spectodaDevice.on("ota_progress", (progress: any) => {
  sse.send(JSON.stringify(progress));
});

interface SpectodaEvent {
  label: string;
  value?: number | string | null;
  type?: "percentage" | "color" | "timestamp" | "undefined";
  destination?: number | number[];
}

app.get("/scan", async (req, res) => {
  // TODO
  // const devices = await spectodaDevice.interface?.scan();
  // res.json(devices);
  return res.json({ status: "error", error: "NotImplemented" });
});

app.post("/connect", async (req, res) => {
  const { key, signature, mac, name, remember, network } = req.body as { signature?: string; key?: string; mac?: string; name?: string; remember?: boolean; network?: string };

  if (connecting) {
    res.statusCode = 405;
    return res.json({ status: "error", error: "ConnectingInProgress" });
  }

  remember && signature && fs.writeFileSync("assets/ownersignature.txt", signature);
  remember && key && fs.writeFileSync("assets/ownerkey.txt", key);
  remember && network && fs.writeFileSync("assets/network.txt", network);

  connecting = true;

  try {
    if (signature) {
      spectodaDevice.assignOwnerSignature(signature);
      console.log("Assign Signature", signature);
    }

    if (key) {
      spectodaDevice.assignOwnerKey(key);
    }

    if (mac) {
      //@ts-ignore
      const result = await spectodaDevice.connect([{ mac: mac }], true, null, null, false, "", true, true);
      remember && fs.writeFileSync("assets/mac.txt", mac);
      return res.json({ status: "success", result: result });
    }

    if (name) {
      const controllers = await spectodaDevice.scan([{ name: name }]);
      controllers.length != 0 && controllers[0].mac && remember && fs.writeFileSync("assets/mac.txt", controllers[0].mac);
      const result = await spectodaDevice.connect(controllers, true, null, null, false, "", true, true);
      return res.json({ status: "success", result: result });
    }

    const controllers = await spectodaDevice.scan([{}]);
    controllers.length != 0 && controllers[0].mac && remember && fs.writeFileSync("assets/mac.txt", controllers[0].mac);

    const result = await spectodaDevice.connect(controllers, true, null, null, false, "", true, true);

    return res.json({ status: "success", result: result });
  } catch (error) {
    if (error === "ScanFailed") {
      // restart node in 10 ms
      setTimeout(() => {
        process.exit(1);
      }, 10);
    }

    res.statusCode = 405;
    return res.json({ status: "error", error: error });
  } finally {
    connecting = false;
  }
});

app.post("/disconnect", async (req, res) => {
  try {
    const result = await spectodaDevice.disconnect();
    return res.json({ status: "success", result: result });
  } catch (error) {
    res.statusCode = 405;
    return res.json({ status: "error", error: error });
  }
});

app.post("/event", async (req, res) => {
  const event = req.body as SpectodaEvent;

  try {
    if (event.label === undefined || event.label === null) {
      res.statusCode = 400;
      return res.json({ status: "error", result: "NoEventLabelSpecified" });
    }

    if (event.value === undefined || event.value === null) {
      const result = await spectodaDevice.emitEvent(event.label, event.destination);
      return res.json({ status: "success", result: result });
    }

    switch (event.type) {
      case "percentage": {
        const result = await spectodaDevice.emitPercentageEvent(event.label, event.value as number, event.destination);
        return res.json({ status: "success", result: result });
      }
      case "color": {
        const result = await spectodaDevice.emitColorEvent(event.label, event.value as string, event.destination);
        return res.json({ status: "success", result: result });
      }
      case "timestamp": {
        const result = await spectodaDevice.emitTimestampEvent(event.label, event.value as number, event.destination);
        return res.json({ status: "success", result: result });
      }
      default: {
        const result = await spectodaDevice.emitEvent(event.label, event.destination);
        return res.json({ status: "success", result: result });
      }
    }
  } catch (error) {
    res.statusCode = 405;
    return res.json({ status: "error", error: error });
  }
});

app.post("/write-tngl", async (req, res) => {
  // TODO: implement, type for write/sync tngl
  const { tngl } = req.body as string;

  // create tngl.txt in assets
  fs.writeFileSync("assets/tngl.txt", tngl);

  const result = await spectodaDevice.writeTngl(fs.readFileSync("assets/tngl.txt", "utf8").toString()); // ! for now to put tngl into webassembly
  await spectodaDevice.readEventHistory();

  return res.json({ status: "success", result });
});

app.get("/tngl-fingerprint", (req, res) => {
  // TODO return finger print of the device
  res.statusCode = 501;
  return res.json({ status: "error", error: "NotImplemented" });
});

app.get("/emit-history", (req, res) => {
  spectodaDevice
    .readEventHistory()
    .then(() => {
      return res.json({ status: "success", result: "success" });
    })
    .catch(error => {
      res.statusCode = 400;
      return res.json({ status: "error", error: error });
    });
});

app.post("/notifier", async (req, res) => {
  const { message } = req.body as { message: string };

  try {
    let parsed: { [key: string]: string } = {};
    message.split(" ").forEach(c => {
      const [key, value] = c.split("=");
      if (key && value) {
        parsed[key.toLowerCase()] = value;
      }
    });

    // console.log(parsed);

    const label = parsed["label"] ?? undefined;
    const value = parsed["value"] ?? undefined;
    const type = parsed["type"] ?? undefined;

    if (label === undefined || label === null) {
      res.statusCode = 400;
      return res.json({ status: "error", result: "NoEventLabelSpecified" });
    }

    if (value === undefined || value === null) {
      const result = await spectodaDevice.emitEvent(label);
      return res.json({ status: "success", result: result });
    }

    if (label) {
      switch (type) {
        case "percentage": {
          const result = await spectodaDevice.emitPercentageEvent(label, Number(value));
          return res.json({ status: "success", result: result });
        }
        case "color": {
          const result = await spectodaDevice.emitColorEvent(label, value as string);
          return res.json({ status: "success", result: result });
        }
        case "timestamp": {
          const result = await spectodaDevice.emitTimestampEvent(label, Number(value));
          return res.json({ status: "success", result: result });
        }
        default: {
          const result = await spectodaDevice.emitEvent(label);
          return res.json({ status: "success", result: result });
        }
      }
      const result = await spectodaDevice.emitEvent(label.substring(0, 5), 255);
      return res.json({ status: "success", result: result });
    }
  } catch (error) {
    res.statusCode = 405;
    return res.json({ status: "error", error: error });
  }
});

app.post("/upload-fw", async (req, res) => {
  if (fwUploading) {
    res.statusCode = 405;
    return res.json({ status: "error", error: "AlreadingUploadingFW" });
  }

  fwUploading = true;

  try {
    const filePath = "/home/pi/spectoda/fw.enc";
    const fileData = fs.readFileSync(filePath);
    const uint8Array = new Uint8Array(fileData);
    const result = await spectodaDevice.updateDeviceFirmware(uint8Array);
    return res.json({ status: "success", result: result });
  } catch (error) {
    res.statusCode = 405;
    return res.json({ status: "error", error: error });
  } finally {
    fwUploading = false;
  }
});

app.get("/", (req, res) => {
  res.redirect("/control");
});

app.get("/assets/control", (req, res) => {
  res.redirect("/control");
});

app.get("/owner", (req, res) => {
  try {
    const info = {
      ownerKey: fs.readFileSync("assets/ownerkey.txt").toString(),
      ownerSignature: fs.readFileSync("assets/ownersignature.txt").toString(),
      network: fs.readFileSync("assets/network.txt").toString(),
    };

    res.json(info);
  } catch (error) {
    res.json({ error });
  }
});

app.get("/variable", async (req, res) => {
  const name = req.query.name;
  const segId = req.query.seg_id;

  if (!name || !segId) {
    res.status(400).json({ error: "Both 'name' and 'seg_id' parameters are required" });
    return;
  }

  // TODO pridat error handling apod
  try {
    const value = await spectodaDevice.readVariable(name, segId);
    res.json({ value: value });
  } catch (error) {
    res.status(404).json({ error: "Variable or segment not found" });
  }
});

app.post("/variables", async (req, res) => {
  const variables = req.body.variables;

  let results = [];
  let fails: any[] = [];

  try {
    for (const { name, segId } of variables) {
      if (!name || !segId) {
        res.status(400).json({ error: "Both 'name' and 'segId' parameters are required" });
        return;
      }

      try {
        const value = await spectodaDevice.readVariable(name, segId);
        results.push({ name, segId, value });
      } catch (error) {
        fails.push({ name, segId, error });
        console.warn(name, segId, error);
        continue;
      }
    }

    res.json({ data: results, fails: fails });
  } catch (error) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.use("/control", express.static("assets/control"));

//An error handling middleware
// @ts-ignore
app.use(function (err, req, res, next) {
  res.status(500);
  res.send("Oops, something went wrong.");
});

app.listen(port, () => {
  console.log(`Listening at http://localhost:${port}/`);
});
