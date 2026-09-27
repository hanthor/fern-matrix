"""Disposable matrix-nio E2EE peer controlled by the Playwright integration suite."""

import asyncio
import base64
import io
import json
import sys
import tempfile

from nio import AsyncClient, AsyncClientConfig, LoginError, ReactionEvent, RoomEncryptedFile, RoomMessageFile, RoomMessageText, RoomSendError, UploadError
from nio.crypto.attachments import decrypt_attachment


async def main():
    directory = tempfile.TemporaryDirectory(prefix="fern-nio-peer-")
    client = None
    sync_task = None
    events = []
    events_changed = asyncio.Event()
    try:
        request = json.loads(await asyncio.to_thread(sys.stdin.readline))
        client = AsyncClient(
            request["homeserver"],
            request["username"],
            store_path=directory.name,
            config=AsyncClientConfig(encryption_enabled=True, store_sync_tokens=True),
        )
        login = await client.login(request["password"], device_name="Fern E2EE integration reference")
        if isinstance(login, LoginError):
            print(json.dumps({"id": request["id"], "error": "Independent Matrix client login failed."}), flush=True)
            return

        async def on_message(room, event):
            events.append({
                "roomId": room.room_id,
                "sender": event.sender,
                "eventId": event.event_id,
                "body": getattr(event, "body", ""),
                "decrypted": bool(getattr(event, "decrypted", False)),
                "encryptedFile": isinstance(event, RoomEncryptedFile),
                "url": getattr(event, "url", None),
                "key": getattr(event, "key", None),
                "hashes": getattr(event, "hashes", None),
                "iv": getattr(event, "iv", None),
                "relatesTo": event.source.get("content", {}).get("m.relates_to", {}),
            })
            events_changed.set()

        client.add_event_callback(on_message, RoomMessageText)
        client.add_event_callback(on_message, RoomEncryptedFile)
        client.add_event_callback(on_message, RoomMessageFile)
        client.add_event_callback(on_message, ReactionEvent)
        sync_task = asyncio.create_task(client.sync_forever(timeout=10_000, full_state=True))
        await asyncio.wait_for(client.synced.wait(), timeout=30)
        print(json.dumps({"id": request["id"], "ok": True, "deviceId": client.device_id}), flush=True)

        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            request = json.loads(line)
            action = request.get("action")
            try:
                if action == "join":
                    response = await client.join(request["roomId"])
                    if not getattr(response, "room_id", None):
                        raise RuntimeError("Independent Matrix client could not join the room.")
                    deadline = asyncio.get_running_loop().time() + 30
                    room = client.rooms.get(request["roomId"])
                    while (room is None or not room.encrypted) and asyncio.get_running_loop().time() < deadline:
                        await asyncio.sleep(0.2)
                        room = client.rooms.get(request["roomId"])
                    if room is None or not room.encrypted:
                        raise RuntimeError("The independent client did not receive the encrypted room state.")
                    result = {"joined": True, "encrypted": True}
                elif action == "send":
                    content = {"msgtype": "m.text", "body": request["body"]}
                    if request.get("replyTo"):
                        content["m.relates_to"] = {"m.in_reply_to": {"event_id": request["replyTo"]}}
                    response = await client.room_send(
                        request["roomId"],
                        message_type="m.room.message",
                        content=content,
                        # This disposable interoperability peer accepts the test
                        # device without asserting cross-signing trust.
                        ignore_unverified_devices=True,
                    )
                    if isinstance(response, RoomSendError):
                        raise RuntimeError("Independent Matrix client could not send the encrypted message.")
                    result = {"sent": True, "eventId": getattr(response, "event_id", None)}
                elif action == "edit":
                    edited = {"msgtype": "m.text", "body": request["body"]}
                    response = await client.room_send(
                        request["roomId"],
                        message_type="m.room.message",
                        content={"msgtype": "m.text", "body": "* " + request["body"], "m.new_content": edited,
                                 "m.relates_to": {"rel_type": "m.replace", "event_id": request["eventId"]}},
                        ignore_unverified_devices=True,
                    )
                    if isinstance(response, RoomSendError):
                        raise RuntimeError("Independent Matrix client could not send the encrypted edit.")
                    result = {"sent": True}
                elif action == "react":
                    response = await client.room_send(
                        request["roomId"],
                        message_type="m.reaction",
                        content={"m.relates_to": {"rel_type": "m.annotation", "event_id": request["eventId"], "key": request["key"]}},
                        ignore_unverified_devices=True,
                    )
                    if isinstance(response, RoomSendError):
                        raise RuntimeError("Independent Matrix client could not send the encrypted reaction.")
                    result = {"sent": True}
                elif action == "send_file":
                    payload = bytes(request["bytes"])
                    response, file_keys = await client.upload(
                        io.BytesIO(payload),
                        content_type="application/octet-stream",
                        filename=request["name"],
                        encrypt=True,
                        filesize=len(payload),
                    )
                    if isinstance(response, UploadError) or not file_keys:
                        detail = response.message if isinstance(response, UploadError) else "missing encryption keys"
                        raise RuntimeError(f"Independent Matrix media upload failed: {detail}.")
                    file_keys["url"] = response.content_uri
                    file_keys["name"] = request["name"]
                    sent = await client.room_send(
                        request["roomId"],
                        message_type="m.room.message",
                        content={
                            "msgtype": "m.file",
                            "body": request["name"],
                            "file": file_keys,
                            "info": {"mimetype": "application/octet-stream", "size": len(payload)},
                        },
                        ignore_unverified_devices=True,
                    )
                    if isinstance(sent, RoomSendError):
                        raise RuntimeError("Independent Matrix client could not send encrypted media.")
                    result = {"sent": True}
                elif action == "wait_text":
                    deadline = asyncio.get_running_loop().time() + 30
                    match = None
                    while match is None:
                        match = next((event for event in reversed(events)
                                      if event["roomId"] == request["roomId"]
                                      and event["sender"] != client.user_id
                                      and event["body"] == request["body"]), None)
                        if match:
                            break
                        remaining = deadline - asyncio.get_running_loop().time()
                        if remaining <= 0:
                            raise RuntimeError("Independent Matrix client did not decrypt the Fern message.")
                        events_changed.clear()
                        try:
                            await asyncio.wait_for(events_changed.wait(), timeout=remaining)
                        except asyncio.TimeoutError:
                            pass
                    result = {"received": True, "decrypted": match["decrypted"]}
                elif action == "wait_file":
                    deadline = asyncio.get_running_loop().time() + 30
                    match = None
                    while match is None:
                        match = next((event for event in reversed(events)
                                      if event["roomId"] == request["roomId"]
                                      and event["sender"] != client.user_id
                                      and event["body"] == request["name"]
                                      and event["encryptedFile"]), None)
                        if match:
                            break
                        remaining = deadline - asyncio.get_running_loop().time()
                        if remaining <= 0:
                            raise RuntimeError("Independent Matrix client did not decrypt the Fern attachment event.")
                        events_changed.clear()
                        try:
                            await asyncio.wait_for(events_changed.wait(), timeout=remaining)
                        except asyncio.TimeoutError:
                            pass
                    downloaded = await client.download(mxc=match["url"])
                    if not hasattr(downloaded, "body"):
                        raise RuntimeError("Independent Matrix client could not download Fern media.")
                    plaintext = decrypt_attachment(downloaded.body, match["key"]["k"], match["hashes"]["sha256"], match["iv"])
                    result = {"received": True, "decrypted": bool(match["decrypted"]), "bytes": base64.b64encode(plaintext).decode("ascii")}
                elif action == "wait_reaction":
                    deadline = asyncio.get_running_loop().time() + 30
                    match = None
                    while match is None:
                        match = next((event for event in reversed(events)
                                      if event["roomId"] == request["roomId"]
                                      and event["sender"] != client.user_id
                                      and event["relatesTo"].get("event_id") == request["eventId"]
                                      and event["relatesTo"].get("key") == request["key"]), None)
                        if match:
                            break
                        remaining = deadline - asyncio.get_running_loop().time()
                        if remaining <= 0:
                            raise RuntimeError("Independent Matrix client did not receive Fern's reaction.")
                        events_changed.clear()
                        try:
                            await asyncio.wait_for(events_changed.wait(), timeout=remaining)
                        except asyncio.TimeoutError:
                            pass
                elif action == "stop":
                    print(json.dumps({"id": request["id"], "ok": True}), flush=True)
                    break
                else:
                    raise RuntimeError("Unknown independent Matrix client test action.")
                print(json.dumps({"id": request["id"], "ok": True, **result}), flush=True)
            except Exception as error:
                message = str(error)
                if "recovery" in message.lower() or "password" in message.lower() or "token" in message.lower():
                    message = "Independent Matrix client operation failed."
                print(json.dumps({"id": request["id"], "error": message}), flush=True)
    finally:
        if sync_task:
            sync_task.cancel()
            await asyncio.gather(sync_task, return_exceptions=True)
        if client:
            await client.close()
        directory.cleanup()


asyncio.run(main())
