import type { Server } from "../server";

export function getHealthHandler(server: Server<any>) {
  return async (request: Request): Promise<Response> => {
    try {
      const health = await server.getHealth();
      return Response.json(health);
    } catch (error) {
      return Response.json(
        {
          status: "unhealthy",
          timestamp: new Date().toISOString(),
          checks: { server: "unhealthy" },
          error: (error as Error).message,
        },
        { status: 500 },
      );
    }
  };
}

export function getMetricsHandler(server: Server<any>) {
  return async (request: Request): Promise<Response> => {
    try {
      const metrics = await server.getMetrics();
      return new Response(metrics, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    } catch (error) {
      return new Response("Metrics collection failed", { status: 500 });
    }
  };
}

export function getStatusHandler(server: Server<any>) {
  return async (request: Request): Promise<Response> => {
    try {
      const status = await server.getStatus();
      return Response.json(status);
    } catch (error) {
      return Response.json(
        { error: "Status retrieval failed", message: (error as Error).message },
        { status: 500 },
      );
    }
  };
}
