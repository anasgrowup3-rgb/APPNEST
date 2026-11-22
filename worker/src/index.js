export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        success: true,
        service: "APPNEST API",
        status: "online"
      });
    }

    return Response.json({
      success: false,
      error: "Endpoint not found"
    }, { status: 404 });
  }
};
