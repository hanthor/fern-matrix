"""Disposable matrix-nio E2EE peer controlled by the Playwright integration suite."""

import asyncio
import base64
import io
import json
import sys
import tempfile

from nio import AsyncClient, AsyncClientConfig, LoginError, ReactionEvent, RoomEncryptedAudio, RoomEncryptedFile, RoomEncryptedImage, RoomEncryptedVideo, RoomMessageEmote, RoomMessageFile, RoomMessageText, RoomMessageUnknown, RoomSendError, UnknownEncryptedEvent, UnknownEvent, UploadError
from nio.crypto.attachments import decrypt_attachment


async def main():
    directory = tempfile.TemporaryDirectory(prefix="fern-nio-peer-")
    client = None
    sync_task = None
    events = []
    raw_events = []
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
            content = event.source.get("content", {})
            events.append({
                "roomId": room.room_id,
                "sender": event.sender,
                "eventId": event.event_id,
                "body": getattr(event, "body", "") or content.get("body", ""),
                "decrypted": bool(getattr(event, "decrypted", False)),
                "encryptedFile": isinstance(event, RoomEncryptedFile),
                "encryptedAudio": isinstance(event, RoomEncryptedAudio),
                "msgtype": content.get("msgtype"),
                "audioBlock": content.get("org.matrix.msc1767.audio"),
                "voiceFlag": content.get("org.matrix.msc3245.voice"),
                "url": getattr(event, "url", None),
                "key": getattr(event, "key", None),
                "hashes": getattr(event, "hashes", None),
                "iv": getattr(event, "iv", None),
                "relatesTo": content.get("m.relates_to", {}),
                "formattedBody": content.get("formatted_body"),
                "format": content.get("format"),
                "mentions": content.get("m.mentions"),
                "info": content.get("info"),
                "geoUri": content.get("geo_uri"),
                "description": content.get("description"),
            })
            events_changed.set()

        async def on_raw(room, event):
            source = getattr(event, "source", {}) or {}
            content = source.get("content", {}) or {}
            raw_events.append({
                "roomId": room.room_id,
                "sender": getattr(event, "sender", source.get("sender", "")),
                "eventId": getattr(event, "event_id", source.get("event_id", "")),
                "type": source.get("type", ""),
                "decrypted": bool(getattr(event, "decrypted", False)),
                "body": content.get("body", ""),
                "relatesTo": content.get("m.relates_to", {}),
                "poll": content.get("m.poll"),
                "selections": content.get("m.selections"),
                "upoll": content.get("org.matrix.msc3381.poll.start"),
                "uresponse": content.get("org.matrix.msc3381.poll.response"),
                "uend": content.get("org.matrix.msc3381.poll.end"),
                "content": content,
                "pollStart": content.get("m.poll.start"),
                "pollResponse": content.get("m.poll.response"),
                "pollEnd": content.get("m.poll.end"),
                "newContent": content.get("m.new_content"),
            })
            events_changed.set()

        client.add_event_callback(on_raw, UnknownEvent)
        client.add_event_callback(on_raw, UnknownEncryptedEvent)
        client.add_event_callback(on_message, RoomMessageText)
        client.add_event_callback(on_message, RoomMessageEmote)
        client.add_event_callback(on_message, RoomEncryptedFile)
        client.add_event_callback(on_message, RoomEncryptedImage)
        client.add_event_callback(on_message, RoomEncryptedAudio)
        client.add_event_callback(on_message, RoomEncryptedVideo)
        client.add_event_callback(on_message, RoomMessageFile)
        client.add_event_callback(on_message, RoomMessageUnknown)
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
                    if request.get("formatted"):
                        content["format"] = "org.matrix.custom.html"
                        content["formatted_body"] = request["formatted"]
                    if request.get("mentions"):
                        content["m.mentions"] = request["mentions"]
                    if request.get("threadOf"):
                        content["m.relates_to"] = {"rel_type": "m.thread", "event_id": request["threadOf"]}
                    elif request.get("replyTo"):
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
                elif action == "send_audio":
                    payload = bytes(request["bytes"])
                    response, file_keys = await client.upload(
                        io.BytesIO(payload),
                        content_type=request.get("mime", "audio/wav"),
                        filename=request["name"],
                        encrypt=True,
                        filesize=len(payload),
                    )
                    if isinstance(response, UploadError) or not file_keys:
                        detail = response.message if isinstance(response, UploadError) else "missing encryption keys"
                        raise RuntimeError(f"Independent Matrix media upload failed: {detail}.")
                    file_keys["url"] = response.content_uri
                    sent = await client.room_send(
                        request["roomId"],
                        message_type="m.room.message",
                        content={
                            "msgtype": "m.audio",
                            "body": request["name"],
                            "file": file_keys,
                            "info": {"mimetype": request.get("mime", "audio/wav"), "size": len(payload),
                                     "duration": request.get("duration", 1000)},
                            "org.matrix.msc1767.audio": {"duration": request.get("duration", 1000),
                                                          "waveform": request.get("waveform", [0, 512, 1024])},
                            "org.matrix.msc3245.voice": {},
                        },
                        ignore_unverified_devices=True,
                    )
                    if isinstance(sent, RoomSendError):
                        raise RuntimeError("Independent Matrix client could not send encrypted audio.")
                    result = {"sent": True}
                elif action == "wait_audio":
                    deadline = asyncio.get_running_loop().time() + 30
                    match = None
                    while match is None:
                        match = next((event for event in reversed(events)
                                      if event["roomId"] == request["roomId"]
                                      and event["sender"] != client.user_id
                                      and event["body"] == request["name"]
                                      and event["encryptedAudio"]), None)
                        if match:
                            break
                        remaining = deadline - asyncio.get_running_loop().time()
                        if remaining <= 0:
                            raise RuntimeError("Independent Matrix client did not decrypt the Fern voice event.")
                        events_changed.clear()
                        try:
                            await asyncio.wait_for(events_changed.wait(), timeout=remaining)
                        except asyncio.TimeoutError:
                            pass
                    downloaded = await client.download(mxc=match["url"])
                    if not hasattr(downloaded, "body"):
                        raise RuntimeError("Independent Matrix client could not download Fern voice.")
                    plaintext = decrypt_attachment(downloaded.body, match["key"]["k"], match["hashes"]["sha256"], match["iv"])
                    result = {"received": True, "decrypted": bool(match["decrypted"]), "msgtype": match["msgtype"],
                              "info": match["info"], "audioBlock": match["audioBlock"], "voiceFlag": match["voiceFlag"],
                              "bytes": base64.b64encode(plaintext).decode("ascii")}
                elif action == "send_location":
                    content = {"msgtype": "m.location", "body": request["body"], "geo_uri": request["geoUri"],
                               "org.matrix.msc1767.text": request["body"]}
                    if request.get("description"):
                        content["description"] = request["description"]
                    response = await client.room_send(
                        request["roomId"],
                        message_type="m.room.message",
                        content=content,
                        ignore_unverified_devices=True,
                    )
                    if isinstance(response, RoomSendError):
                        raise RuntimeError("Independent Matrix client could not send the location.")
                    result = {"sent": True}
                elif action == "send_poll":
                    # The vendored SDK speaks unstable MSC3381 polls: mirror
                    # its exact wire shape (captured live) for interop sends.
                    kind = ("org.matrix.msc3381.poll.undisclosed" if request.get("undisclosed")
                            else "org.matrix.msc3381.poll.disclosed")
                    answers = [{"id": answer["id"], "org.matrix.msc1767.text": answer["text"]}
                               for answer in request["answers"]]
                    content = {"org.matrix.msc3381.poll.start": {
                        "question": {"org.matrix.msc1767.text": request["question"]},
                        "kind": kind, "max_selections": 1, "answers": answers},
                        "org.matrix.msc1767.text": request["question"]}
                    response = await client.room_send(
                        request["roomId"],
                        message_type="org.matrix.msc3381.poll.start",
                        content=content,
                        ignore_unverified_devices=True,
                    )
                    if isinstance(response, RoomSendError):
                        raise RuntimeError("Independent Matrix client could not send the poll.")
                    result = {"sent": True, "eventId": getattr(response, "event_id", None)}
                elif action == "send_poll_edit":
                    answers = [{"id": answer["id"], "org.matrix.msc1767.text": answer["text"]}
                               for answer in request["answers"]]
                    replacement = {"org.matrix.msc3381.poll.start": {
                        "question": {"org.matrix.msc1767.text": request["question"]},
                        "kind": "org.matrix.msc3381.poll.disclosed",
                        "max_selections": 1, "answers": answers},
                        "org.matrix.msc1767.text": request["question"]}
                    response = await client.room_send(
                        request["roomId"],
                        message_type="org.matrix.msc3381.poll.start",
                        content={"body": "* " + request["question"], "m.new_content": replacement,
                                 "m.relates_to": {"rel_type": "m.replace", "event_id": request["eventId"]}},
                        ignore_unverified_devices=True,
                    )
                    if isinstance(response, RoomSendError):
                        raise RuntimeError("Independent Matrix client could not send the poll edit.")
                    result = {"sent": True}
                elif action == "send_poll_response":
                    response = await client.room_send(
                        request["roomId"],
                        message_type="org.matrix.msc3381.poll.response",
                        content={"m.relates_to": {"rel_type": "m.reference", "event_id": request["eventId"]},
                                 "org.matrix.msc3381.poll.response": {"answers": request.get("answers", [])}},
                        ignore_unverified_devices=True,
                    )
                    if isinstance(response, RoomSendError):
                        raise RuntimeError("Independent Matrix client could not send the poll response.")
                    result = {"sent": True}
                elif action == "send_poll_end":
                    text = request.get("text", "The poll has ended.")
                    response = await client.room_send(
                        request["roomId"],
                        message_type="org.matrix.msc3381.poll.end",
                        content={"org.matrix.msc1767.text": text,
                                 "m.relates_to": {"rel_type": "m.reference", "event_id": request["eventId"]}},
                        ignore_unverified_devices=True,
                    )
                    if isinstance(response, RoomSendError):
                        raise RuntimeError("Independent Matrix client could not send the poll end.")
                    result = {"sent": True}
                elif action == "wait_poll":
                    def question_of(event):
                        block = event.get("upoll") or event.get("poll") or {}
                        question = block.get("question", {})
                        text = question.get("org.matrix.msc1767.text", question.get("m.text", "?"))
                        return text[0]["body"] if isinstance(text, list) else text
                    deadline = asyncio.get_running_loop().time() + 30
                    match = None
                    while match is None:
                        match = next((event for event in reversed(raw_events)
                                      if event["roomId"] == request["roomId"]
                                      and event["sender"] != client.user_id
                                      and event["type"] == request["type"]
                                      and (not request.get("body") or event["body"] == request["body"])
                                      and (not request.get("question") or question_of(event) == request["question"])
                                      and (not request.get("relatesTo")
                                           or event["relatesTo"].get("event_id") == request["relatesTo"])), None)
                        if match:
                            break
                        remaining = deadline - asyncio.get_running_loop().time()
                        if remaining <= 0:
                            raise RuntimeError("Independent Matrix client did not receive the Fern poll event.")
                        events_changed.clear()
                        try:
                            await asyncio.wait_for(events_changed.wait(), timeout=remaining)
                        except asyncio.TimeoutError:
                            pass
                    result = {"received": True, "decrypted": bool(match["decrypted"]), "match": match}
                elif action == "wait_location":
                    deadline = asyncio.get_running_loop().time() + 30
                    match = None
                    while match is None:
                        match = next((event for event in reversed(events)
                                      if event["roomId"] == request["roomId"]
                                      and event["sender"] != client.user_id
                                      and event["msgtype"] == "m.location"
                                      and (not request.get("body") or event["body"] == request["body"])), None)
                        if match:
                            break
                        remaining = deadline - asyncio.get_running_loop().time()
                        if remaining <= 0:
                            raise RuntimeError("Independent Matrix client did not decrypt the Fern location event.")
                        events_changed.clear()
                        try:
                            await asyncio.wait_for(events_changed.wait(), timeout=remaining)
                        except asyncio.TimeoutError:
                            pass
                    result = {"received": True, "decrypted": bool(match["decrypted"]), "body": match["body"],
                              "geoUri": match["geoUri"], "description": match["description"]}
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
                    result = {"received": True, "decrypted": match["decrypted"], "msgtype": match["msgtype"]}
                elif action == "wait_formatted":
                    deadline = asyncio.get_running_loop().time() + 30
                    match = None
                    while match is None:
                        match = next((event for event in reversed(events)
                                      if event["roomId"] == request["roomId"]
                                      and event["sender"] != client.user_id
                                      and event["body"] == request["body"]
                                      and event["formattedBody"]), None)
                        if match:
                            break
                        remaining = deadline - asyncio.get_running_loop().time()
                        if remaining <= 0:
                            raise RuntimeError("Independent Matrix client did not receive the formatted Fern message.")
                        events_changed.clear()
                        try:
                            await asyncio.wait_for(events_changed.wait(), timeout=remaining)
                        except asyncio.TimeoutError:
                            pass
                    result = {"received": True, "decrypted": match["decrypted"],
                              "formattedBody": match["formattedBody"], "format": match["format"],
                              "mentions": match["mentions"]}
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
                elif action == "wait_image":
                    deadline = asyncio.get_running_loop().time() + 30
                    match = None
                    while match is None:
                        match = next((event for event in reversed(events)
                                      if event["roomId"] == request["roomId"]
                                      and event["sender"] != client.user_id
                                      and event["body"] == request["name"]
                                      and event["url"]), None)
                        if match:
                            break
                        remaining = deadline - asyncio.get_running_loop().time()
                        if remaining <= 0:
                            raise RuntimeError("Independent Matrix client did not receive the Fern image.")
                        events_changed.clear()
                        try:
                            await asyncio.wait_for(events_changed.wait(), timeout=remaining)
                        except asyncio.TimeoutError:
                            pass
                    downloaded = await client.download(mxc=match["url"])
                    if not hasattr(downloaded, "body"):
                        raise RuntimeError("Independent Matrix client could not download the Fern image.")
                    plaintext = decrypt_attachment(downloaded.body, match["key"]["k"], match["hashes"]["sha256"], match["iv"])
                    result = {"received": True, "decrypted": bool(match["decrypted"]), "info": match["info"],
                              "bytes": base64.b64encode(plaintext).decode("ascii")}
                elif action == "wait_thread":
                    deadline = asyncio.get_running_loop().time() + 30
                    match = None
                    while match is None:
                        match = next((event for event in reversed(events)
                                      if event["roomId"] == request["roomId"]
                                      and event["sender"] != client.user_id
                                      and event["body"] == request["body"]
                                      and event["relatesTo"].get("rel_type") == "m.thread"
                                      and event["relatesTo"].get("event_id") == request["threadOf"]), None)
                        if match:
                            break
                        remaining = deadline - asyncio.get_running_loop().time()
                        if remaining <= 0:
                            raise RuntimeError("Independent Matrix client did not receive the threaded Fern message.")
                        events_changed.clear()
                        try:
                            await asyncio.wait_for(events_changed.wait(), timeout=remaining)
                        except asyncio.TimeoutError:
                            pass
                    result = {"received": True, "decrypted": match["decrypted"], "relatesTo": match["relatesTo"]}
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
                elif action == "fetch_event":
                    # Fetching an undecryptable event makes nio request its
                    # session automatically, so this wait doubles as the share
                    # window: a persistent MegolmEvent means the sender's
                    # devices never answered.
                    deadline = asyncio.get_running_loop().time() + 30
                    event = None
                    while event is None or type(event).__name__ == "MegolmEvent":
                        fetched = await client.room_get_event(request["roomId"], request["eventId"])
                        event = getattr(fetched, "event", None)
                        if event is not None and type(event).__name__ != "MegolmEvent":
                            break
                        if asyncio.get_running_loop().time() >= deadline:
                            break
                        await asyncio.sleep(2)
                    result = {"fetched": event is not None, "kind": type(event).__name__,
                              "decrypted": bool(getattr(event, "decrypted", False)),
                              "body": getattr(event, "body", "") if event is not None else ""}
                elif action == "dump_raw":
                    result = {"events": raw_events[-25:]}
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
