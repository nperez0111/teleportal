import { Provider } from "teleportal/providers";
import { createTokenManager } from "teleportal/token";

// just for illustration, we create the token on the client
// in production, you would generate the token on the server and send it to the client
const tokenManager = createTokenManager({
  secret: "your-secret-key-here",
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

// create a JWT token for the user
const token = await tokenManager.createToken(
  // user id
  "nick",
  // room id (multi-tenant)
  "docs",
  // document access patterns and permissions
  [
    // allow the user to have full access to all documents
    { pattern: "*", permissions: ["admin"] },
  ],
);

const provider = await Provider.create({
  url: `http://localhost:3000?token=${token}`,
  document: "test",
});

await provider.synced;

provider.doc.getText("test").insert(0, "Hello, world!");

console.log(provider.doc.getText("test").toString());

provider.doc.on("update", () => {
  console.log(provider.doc.getText("test").toString());
});
