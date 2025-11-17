import { serve } from "bun";
import index from "./index.html";

// In-memory storage for offers and answers
interface Offer {
  id: string;
  offer: string;
  timestamp: number;
}

interface Answer {
  offerId: string;
  answer: string;
  timestamp: number;
}

const offers = new Map<string, Offer>();
const answers = new Map<string, Answer>();

// SSE clients for offers (presenter listens)
const offerClients = new Set<ReadableStreamDefaultController>();

// SSE clients for answers (casters listen by offerId)
const answerClients = new Map<string, Set<ReadableStreamDefaultController>>();

function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

const server = serve({
  routes: {
    // Serve index.html for all unmatched routes.
    "/*": index,

    // POST endpoint to save offer from caster
    "/api/offer": {
      async POST(req) {
        try {
          const body = await req.json();
          const { offer } = body;

          if (!offer) {
            return Response.json({ error: "Offer is required" }, { status: 400 });
          }

          const offerId = generateId();
          const offerData: Offer = {
            id: offerId,
            offer: JSON.stringify(offer),
            timestamp: Date.now(),
          };

          offers.set(offerId, offerData);

          // Notify all presenter clients via SSE
          const message = `data: ${JSON.stringify({ offerId, offer: offerData.offer })}\n\n`;
          offerClients.forEach((controller) => {
            try {
              controller.enqueue(new TextEncoder().encode(message));
            } catch (e) {
              // Client disconnected
            }
          });

          return Response.json({ offerId });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Failed to save offer" },
            { status: 500 }
          );
        }
      },
    },

    // POST endpoint to save answer from presenter
    "/api/answer/:offerId": async (req) => {
      try {
        const offerId = req.params.offerId;
        const body = await req.json();
        const { answer } = body;

        if (!answer) {
          return Response.json({ error: "Answer is required" }, { status: 400 });
        }

        if (!offers.has(offerId)) {
          return Response.json({ error: "Offer not found" }, { status: 404 });
        }

        const answerData: Answer = {
          offerId,
          answer: JSON.stringify(answer),
          timestamp: Date.now(),
        };

        answers.set(offerId, answerData);
        console.log(`Answer received for offerId ${offerId}, notifying ${answerClients.get(offerId)?.size || 0} clients`);

        // Notify the caster client via SSE
        const message = `data: ${JSON.stringify({ offerId, answer: answerData.answer })}\n\n`;
        const clients = answerClients.get(offerId);
        if (clients && clients.size > 0) {
          clients.forEach((controller) => {
            try {
              controller.enqueue(new TextEncoder().encode(message));
              console.log(`Sent answer to client for offerId ${offerId}`);
            } catch (e) {
              console.error(`Failed to send answer to client:`, e);
              // Client disconnected
            }
          });
        } else {
          console.warn(`No clients connected for offerId ${offerId}, answer will be sent when client connects`);
        }

        return Response.json({ success: true });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : "Failed to save answer" },
          { status: 500 }
        );
      }
    },

    // SSE endpoint for presenter to listen for new offers
    "/api/offers/stream": {
      GET(req) {
        const stream = new ReadableStream({
          start(controller) {
            offerClients.add(controller);

            // Send initial comment to establish connection
            try {
              controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            } catch (e) {
              console.error("Failed to send initial SSE message:", e);
            }

            // Send existing offers
            offers.forEach((offer) => {
              try {
                const message = `data: ${JSON.stringify({ offerId: offer.id, offer: offer.offer })}\n\n`;
                controller.enqueue(new TextEncoder().encode(message));
              } catch (e) {
                console.error("Failed to send existing offer:", e);
              }
            });

            // Send keep-alive every 30 seconds
            const keepAliveInterval = setInterval(() => {
              try {
                controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
              } catch (e) {
                clearInterval(keepAliveInterval);
              }
            }, 30000);

            req.signal.addEventListener("abort", () => {
              clearInterval(keepAliveInterval);
              offerClients.delete(controller);
              try {
                controller.close();
              } catch (e) {
                // Already closed
              }
            });
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      },
    },

    // SSE endpoint for caster to listen for answers
    "/api/answers/stream/:offerId": (req) => {
      const offerId = req.params.offerId;

      let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
      let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

      const stream = new ReadableStream({
        start(controller) {
          streamController = controller;
          if (!answerClients.has(offerId)) {
            answerClients.set(offerId, new Set());
          }
          answerClients.get(offerId)!.add(controller);
          console.log(`Caster connected for offerId ${offerId}, ${answerClients.get(offerId)?.size} total clients`);

          // Send initial comment to establish connection
          try {
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
          } catch (e) {
            console.error("Failed to send initial SSE message:", e);
            return;
          }

          // Send existing answer if available
          const existingAnswer = answers.get(offerId);
          if (existingAnswer) {
            console.log(`Sending existing answer to caster for offerId ${offerId}`);
            try {
              const message = `data: ${JSON.stringify({ offerId, answer: existingAnswer.answer })}\n\n`;
              controller.enqueue(new TextEncoder().encode(message));
            } catch (e) {
              console.error("Failed to send existing answer:", e);
            }
          } else {
            console.log(`No existing answer for offerId ${offerId}, waiting...`);
          }

          // Send keep-alive every 15 seconds (more frequent to keep connection alive)
          keepAliveInterval = setInterval(() => {
            if (streamController) {
              try {
                streamController.enqueue(new TextEncoder().encode(": keepalive\n\n"));
              } catch (e) {
                console.error("Failed to send keepalive:", e);
                if (keepAliveInterval) {
                  clearInterval(keepAliveInterval);
                  keepAliveInterval = null;
                }
              }
            }
          }, 15000);

          req.signal.addEventListener("abort", () => {
            if (keepAliveInterval) {
              clearInterval(keepAliveInterval);
              keepAliveInterval = null;
            }
            const clients = answerClients.get(offerId);
            if (clients && streamController) {
              clients.delete(streamController);
              if (clients.size === 0) {
                answerClients.delete(offerId);
              }
            }
            try {
              if (streamController) {
                streamController.close();
              }
            } catch (e) {
              // Already closed
            }
          });
        },
        cancel() {
          if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
          }
          const clients = answerClients.get(offerId);
          if (clients && streamController) {
            clients.delete(streamController);
            if (clients.size === 0) {
              answerClients.delete(offerId);
            }
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
