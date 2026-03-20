import serial

# Open the serial port

ser = serial.Serial('/dev/ttyUSB2', 115200, timeout=1)

# Send an AT command

command = "AT$GPSNMUN=2,1,1,1,1,1,1\r\n" #AT command followed by carriage return
ser.write(command.encode())

# Read the response
response = ser.readline().decode().strip()

# Print the response
print(response)

# Close the serial port
ser.close()
